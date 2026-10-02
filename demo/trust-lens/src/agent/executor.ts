/**
 * Acme Invoice Agent — an A2A server whose sensitive step requires a verifiable
 * authorization from a human, over the published OID4VP In-Task Auth extension.
 *
 * The shape of the demo: the agent works happily until it reaches the payment export, then
 * pauses in `auth-required` carrying an OID4VP request. It resumes only once the operator has
 * presented a Finance Data Officer credential — disclosing role and organisation, nothing else.
 *
 * One addition over the reference demo, and it is the point of this one: Heka's verifier confirms
 * the presentation is cryptographically sound but does **not** consult the issuer's status list,
 * nor constrain the issuer. So after a valid presentation this agent evaluates the presented
 * credential itself (src/shared/presented-credential.ts). Without that, revoking the officer
 * credential would not actually deny anything.
 *
 * The process entry point is ./index.ts; this module is importable so the executor can be tested.
 */

import { randomUUID } from 'node:crypto'

import { AgentCard, Message, TaskStatusUpdateEvent, TextPart } from '@a2a-js/sdk'
import { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server'
import { WebSocket } from 'ws'

import { loadState } from '../seed/state'
import { IdentityServiceClient } from '../shared/identity-service'
import {
  authorizedResult,
  deniedResult,
  NO_PRESENTATION_IN_TIME,
  requestedFromDefinition,
} from '../shared/authorization-result'
import {
  evaluateOfficerPresentation,
  officerPresentationDefinition,
  PresentationRefused,
  PresentedCredential,
  StatusCheck,
} from '../shared/presented-credential'
import { retryUntil } from '../shared/retry'
import {
  IN_TASK_OID4VP_EXTENSION_URI,
  InTaskOpenId4VpAuthorizationRequest,
  InTaskOpenId4VpAuthorizationResult,
  InTaskOpenId4VpAuthorizationStatus,
  InTaskOpenId4VpExtension,
  InTaskOpenId4VpMessageMetadata,
} from './extension'
import { prepareInvoiceReport, SENSITIVE_STEP } from './invoice-work'
import { AgentState } from './state'

/** Ask for the officer credential, disclosing only role and organisation. */
const OFFICER_PRESENTATION_DEFINITION = officerPresentationDefinition(
  'Authorize preparation of a supplier payment export'
)

/** The same definition in plain fields, so the client can show what is asked (demo addition). */
const OFFICER_REQUESTED = requestedFromDefinition(OFFICER_PRESENTATION_DEFINITION)

/** What the agent says as the wallet moves the verifier session along; other states are silent. */
const SESSION_STATE_TEXT: Record<string, string> = {
  RequestUriRetrieved: 'The wallet fetched the request.',
  ResponseVerified: "Presentation verified; checking the credential's status.",
}

/** The extension's metadata slot: one key, the spec field plus the labelled demo additions. */
function withExtension(metadata: InTaskOpenId4VpMessageMetadata): Record<string, unknown> {
  return { [IN_TASK_OID4VP_EXTENSION_URI]: metadata }
}

/**
 * The agent's live card. `publicUrl` is what A2A clients actually connect to, so it must be
 * reachable from the client, not just from here (they are different hosts under Docker).
 */
export function agentCard(publicUrl: string): AgentCard {
  return {
    name: 'Acme Invoice Agent',
    description: 'Autonomous supplier invoice reconciliation and payment preparation.',
    url: publicUrl,
    provider: { organization: 'Acme Corp GmbH', url: 'https://acme-invoices.example' },
    version: '1.0.0',
    protocolVersion: '1.0',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
      extensions: [
        {
          uri: IN_TASK_OID4VP_EXTENSION_URI,
          description: 'Sensitive task steps require an OID4VP presentation from the operator',
          required: false,
          params: { oid4vpVersions: ['1.0'] },
        } satisfies InTaskOpenId4VpExtension,
      ],
    },
    securitySchemes: undefined,
    security: undefined,
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [
      {
        id: 'invoice-reconciliation',
        name: 'Supplier invoice reconciliation',
        description: 'Reconciles supplier invoices for a period and prepares a payment export.',
        tags: ['finance', 'invoices'],
        examples: ['Reconcile May supplier invoices and prepare the payment export'],
        inputModes: ['text'],
        outputModes: ['text'],
      },
    ],
    supportsAuthenticatedExtendedCard: false,
  }
}

export class AuthorizationDenied extends Error {
  public constructor(
    message: string,
    /** What the client is told (demo addition); absent only when the denial has no session. */
    public readonly result?: InTaskOpenId4VpAuthorizationResult
  ) {
    super(message)
    this.name = 'AuthorizationDenied'
  }
}

/** Thrown inside the wait loop once `tasks/cancel` set the flag: the execution stops without another update. */
export class TaskCancelled extends Error {
  public constructor() {
    super('task cancelled')
    this.name = 'TaskCancelled'
  }
}

export interface ExecutorOptions {
  /** Long enough for a human to pick up a phone, scan and consent. */
  authorizationTimeoutMs: number
}

export class InvoiceAgentExecutor implements AgentExecutor {
  /** Sessions this agent opened — the filter that keeps the AS's sessions on the shared tenant out. */
  private readonly ownSessions = new Set<string>()
  /** Latest Heka state per session this agent opened — what `authorizationStatus` forwards. */
  private readonly sessionStates = new Map<string, string>()
  private readonly cancelled = new Set<string>()

  /** Failed connects since the channel was last open; the retry delay doubles with them, up to 30 s. */
  private reconnects = 0

  /** Read by the server view once `initialize` has run. */
  public verifierDid: string | null = null

  public constructor(
    private readonly identityService: IdentityServiceClient,
    public readonly state: AgentState,
    private readonly options: ExecutorOptions
  ) {}

  public async initialize(): Promise<void> {
    this.verifierDid = await this.identityService.prepareWallet()
    console.log(`[agent] verifier identity: ${this.verifierDid}`)
    this.connectNotifications()
  }

  /**
   * Heka pushes verification-session state changes over a WebSocket. The socket does not
   * survive a restart of the Identity Service (re-creating its container to change the
   * advertised OID4VC address is a documented step), so reconnect rather than go deaf — and
   * `waitForVerifiedPresentation` also asks Heka directly, in case a state change fell into the gap.
   */
  private connectNotifications(): void {
    this.state.channelState('connecting')
    const socket = new WebSocket(this.identityService.notificationsUrl(), {
      headers: { Authorization: `Bearer ${process.env.IDENTITY_SERVICE_ACCESS_TOKEN}` },
    })
    socket.on('open', () => {
      this.reconnects = 0
      console.log('[agent] notification channel open')
      this.state.channelState('open')
    })
    socket.on('error', (error: Error) => {
      console.log(`[agent] notification error: ${error.message}`)
      this.state.channelError(error.message)
    })
    socket.on('message', (raw: Buffer) => this.onNotification(raw))
    socket.on('close', (code: number) => {
      const delay = Math.min(30_000, 3_000 * 2 ** this.reconnects++)
      console.log(`[agent] notification channel closed (${code}); reconnecting in ${delay / 1000}s`)
      this.state.channelState('closed', `code ${code}`)
      setTimeout(() => this.connectNotifications(), delay)
    })
  }

  private onNotification(raw: Buffer): void {
    let message: { type?: string; verificationSession?: { id?: string; state?: string } }
    try {
      message = JSON.parse(raw.toString())
    } catch {
      return
    }

    const session = message.verificationSession
    if (message.type !== 'OpenId4VcVerifier.VerificationSessionStateChanged' || !session?.id) return

    // Heka notifies for every session in the tenant, the AS's included; only ours are tracked.
    if (!this.ownSessions.has(session.id)) return
    console.log(`[agent] session ${session.id.slice(0, 8)} -> ${session.state}`)
    if (session.state) this.noteSessionState(session.id, session.state)
  }

  /** One entry point for the WebSocket and the poll fallback, so a state is journaled once. */
  private noteSessionState(sessionId: string, state: string): void {
    if (this.sessionStates.get(sessionId) === state) return
    this.sessionStates.set(sessionId, state)
    this.state.sessionState(sessionId, state)
  }

  /**
   * The SDK calls this on `tasks/cancel` and then waits for a final event on the task's bus, so
   * the cancellation is published here; the running execution sees the flag and stops without
   * another update. A pending verifier session is left to expire on its own.
   */
  public cancelTask = async (taskId: string, eventBus: ExecutionEventBus): Promise<void> => {
    this.cancelled.add(taskId)
    const contextId = this.state.tasks.get(taskId)?.contextId ?? ''
    eventBus.publish({
      kind: 'status-update',
      taskId,
      contextId,
      status: { state: 'canceled', timestamp: new Date().toISOString() },
      final: true,
    })
    this.state.taskStep(taskId, contextId, 'canceled', 'Cancelled by the client.')
    this.state.cancelPendingAuthorization(taskId)
  }

  /**
   * Forget which contexts were authorized, for the revocation demo on a reused context. Sessions
   * still being waited on keep their state; only decided ones are pruned from the maps.
   */
  public forgetAuthorizations(): number {
    for (const sessionId of [...this.ownSessions]) {
      if (this.state.isDecided(sessionId)) {
        this.ownSessions.delete(sessionId)
        this.sessionStates.delete(sessionId)
      }
    }
    return this.state.forgetAuthorizations()
  }

  public async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const userMessage = context.userMessage
    // The SDK's id: it keys the task's event bus by it, so `tasks/cancel` finds the running task.
    const taskId = context.taskId
    const contextId = userMessage.contextId ?? context.task?.contextId ?? randomUUID()

    if (!context.task) {
      eventBus.publish({
        kind: 'task',
        id: taskId,
        contextId,
        status: { state: 'submitted', timestamp: new Date().toISOString() },
        history: [userMessage],
        metadata: userMessage.metadata,
      })
      this.state.taskStep(taskId, contextId, 'submitted')
    }

    const say = (state: 'working' | 'auth-required' | 'completed' | 'failed', text: string, extra?: object) => {
      // `tasks/cancel` already published the final `canceled`; anything after it would reopen the task.
      if (this.cancelled.has(taskId)) throw new TaskCancelled()
      const update: TaskStatusUpdateEvent = {
        kind: 'status-update',
        taskId,
        contextId,
        status: {
          state,
          message: {
            kind: 'message',
            role: 'agent',
            messageId: randomUUID(),
            parts: [{ kind: 'text', text }],
            taskId,
            contextId,
            ...(extra ?? {}),
          },
          timestamp: new Date().toISOString(),
        },
        final: state === 'completed' || state === 'failed',
      }
      eventBus.publish(update)
      this.state.taskStep(taskId, contextId, state, text)
    }

    // Set only when this task ran the authorization itself; a context authorized earlier has none.
    let result: InTaskOpenId4VpAuthorizationResult | undefined

    try {
      say('working', 'Reconciling supplier invoices for the period…')

      // Routine work needs no authorization; only the export does.
      if (!this.state.authorizedContexts.has(contextId)) {
        say('working', `Reconciliation complete. ${SENSITIVE_STEP} requires authorization.`)

        const { request, sessionId, expiresAt } = await this.requestAuthorization(taskId, contextId)
        const statusOf = (state: string): InTaskOpenId4VpAuthorizationStatus => ({
          sessionId,
          state,
          expiresAt,
          requested: OFFICER_REQUESTED,
        })

        say('auth-required', 'Present a Finance Data Officer credential to authorize the payment export.', {
          metadata: withExtension({ authorizationRequest: request, authorizationStatus: statusOf('RequestCreated') }),
        })

        const { presented, status } = await this.awaitAuthorization(taskId, sessionId, expiresAt, (state) => {
          const text = SESSION_STATE_TEXT[state]
          if (text) say('working', text, { metadata: withExtension({ authorizationStatus: statusOf(state) }) })
        })
        result = authorizedResult(presented, status)
        this.state.authorizationDecided(result)
        console.log(`[agent] context ${contextId.slice(0, 8)} authorized`)
        say('working', 'Authorization accepted. Preparing the payment export…')
      }

      // Cancelled while waiting: `canceled` was already published; anything more would reopen the task.
      if (this.cancelled.has(taskId)) return

      const report = await prepareInvoiceReport(collectText(context), (reason) =>
        this.state.llmFallback(taskId, contextId, reason)
      )
      if (this.cancelled.has(taskId)) return
      say('completed', report, result ? { metadata: withExtension({ authorizationResult: result }) } : undefined)
    } catch (error) {
      if (error instanceof TaskCancelled || this.cancelled.has(taskId)) return
      const denied = error instanceof AuthorizationDenied
      console.log(`[agent] task ${taskId.slice(0, 8)} ${denied ? 'denied' : 'failed'}: ${(error as Error).message}`)
      const message = (error as Error).message
      if (denied && error.result) this.state.authorizationDecided(error.result)
      say(
        'failed',
        denied ? `Authorization denied: ${message}` : `Agent error: ${message}`,
        denied && error.result ? { metadata: withExtension({ authorizationResult: error.result }) } : undefined
      )
    } finally {
      this.cancelled.delete(taskId)
    }
  }

  private async requestAuthorization(taskId: string, contextId: string) {
    const response = await this.identityService.createVerificationSession({
      publicVerifierId: this.verifierDid as string,
      requestSigner: { method: 'did', did: this.verifierDid as string },
      presentationExchange: { definition: OFFICER_PRESENTATION_DEFINITION },
    })

    const sessionId = response.verificationSession.id
    // The agent's own deadline; the verifier session has a shorter lifetime Heka does not expose.
    const expiresAt = new Date(Date.now() + this.options.authorizationTimeoutMs).toISOString()
    this.ownSessions.add(sessionId)
    this.state.authorizationRequested({ sessionId, taskId, contextId, expiresAt })
    // Cancelled while the session was being created: settle the record now, nothing will wait on it.
    if (this.cancelled.has(taskId)) this.state.cancelPendingAuthorization(taskId)
    console.log(
      `[agent] authorization requested: session ${sessionId.slice(0, 8)} for context ${contextId.slice(0, 8)}`
    )

    return {
      sessionId,
      expiresAt,
      request: {
        client_id: this.verifierDid as string,
        request_uri: response.authorizationRequest,
      } as InTaskOpenId4VpAuthorizationRequest,
    }
  }

  private async awaitAuthorization(
    taskId: string,
    sessionId: string,
    expiresAt: string,
    onState: (state: string) => void
  ): Promise<{ presented: PresentedCredential; status: StatusCheck }> {
    const deadline = Date.parse(expiresAt)
    await this.waitForVerifiedPresentation(taskId, sessionId, deadline, onState)

    // Heka verified the signature and the key binding. Whether this relying party accepts the
    // credential — its issuer, its type, and whether it is still live — is decided here, against
    // the presented token itself. Never against a seed slot: the slot says what was issued, the
    // token says what was shown.
    try {
      // The session is verified; one failed read of it must not fail a task whose presentation was good.
      const session = await retryUntil(() => this.identityService.getVerificationSession(sessionId), deadline)
      const evaluated = await evaluateOfficerPresentation(session, {
        trustedIssuer: loadState().issuerDid,
        statusListOrigin: this.identityService.baseOrigin,
        log: (line) => console.log(`[agent] ${line}`),
      })
      this.state.statusChecked(sessionId, evaluated.status)
      return evaluated
    } catch (error) {
      if (!(error instanceof PresentationRefused)) throw error
      console.log(`[agent] presentation refused (${error.reason}): ${error.message}`)
      // Every refusal carries a result, so the record is decided — a missing trust anchor included.
      const result = deniedResult(sessionId, error.message, error.presented, error.reason)
      if (result.status) this.state.statusChecked(sessionId, result.status)
      throw new AuthorizationDenied(error.message, result)
    }
  }

  /**
   * Resolve once Heka reports `ResponseVerified`, calling `onState` on every state change on the
   * way (the wallet fetching the request is the first sign of life the operator can see). The
   * WebSocket is the fast path; every few seconds Heka is asked directly in case a notification
   * fell into a reconnect gap. A cancelled task stops waiting on the next tick.
   */
  private waitForVerifiedPresentation(
    taskId: string,
    sessionId: string,
    deadline: number,
    onState: (state: string) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let reported = 'RequestCreated'
      let ticks = 0
      let checking = false
      const poll = setInterval(async () => {
        if (this.cancelled.has(taskId)) {
          clearInterval(poll)
          reject(new TaskCancelled())
          return
        }
        const state = this.sessionStates.get(sessionId)
        if (state && state !== reported) {
          reported = state
          try {
            onState(state)
          } catch {
            // onState publishes; after a cancel that throws, and the next tick ends the wait.
          }
        }
        if (state === 'ResponseVerified') {
          clearInterval(poll)
          resolve()
          return
        }
        if (Date.now() > deadline) {
          clearInterval(poll)
          reject(new AuthorizationDenied(NO_PRESENTATION_IN_TIME, deniedResult(sessionId, NO_PRESENTATION_IN_TIME)))
          return
        }
        // Belt and braces: every few seconds, ask Heka in case the notification never came.
        if (++ticks % 6 === 0 && !checking) {
          checking = true
          try {
            const session = await this.identityService.getVerificationSession(sessionId)
            if (session.state) this.noteSessionState(sessionId, session.state)
          } catch {
            // Transient; the next tick tries again and the deadline still bounds the wait.
          } finally {
            checking = false
          }
        }
      }, 500)
    })
  }
}

function collectText(context: RequestContext): string {
  const history = context.task?.history ?? []
  const messages = history.some((m) => m.messageId === context.userMessage.messageId)
    ? history
    : [...history, context.userMessage]

  return messages
    .flatMap((message: Message) => message.parts.filter((p): p is TextPart => p.kind === 'text').map((p) => p.text))
    .join('\n')
}
