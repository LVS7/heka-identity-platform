/**
 * Acme Invoice Agent — an A2A server whose sensitive step requires a verifiable
 * authorization from a human, over the published OID4VP In-Task Auth extension.
 *
 * The shape of the demo: the agent works happily until it reaches the payment export, then
 * pauses in `auth-required` carrying an OID4VP request. It resumes only once the operator has
 * presented a Finance Data Officer credential — disclosing role and organisation, nothing else.
 *
 * One addition over the reference demo, and it is the point of Part IV: Heka's verifier confirms
 * the presentation is cryptographically sound but does **not** consult the issuer's status list,
 * nor constrain the issuer. So after a valid presentation this agent evaluates the presented
 * credential itself (src/shared/presented-credential.ts). Without that, revoking the officer
 * credential would not actually deny anything.
 */

import express from 'express'
import { randomUUID } from 'node:crypto'

import { AgentCard, Message, TaskStatusUpdateEvent, TextPart } from '@a2a-js/sdk'
import {
  AgentExecutor,
  DefaultRequestHandler,
  ExecutionEventBus,
  InMemoryTaskStore,
  RequestContext,
  TaskStore,
} from '@a2a-js/sdk/server'
import { A2AExpressApp } from '@a2a-js/sdk/server/express'
import * as dotenv from 'dotenv'
import { WebSocket } from 'ws'

import { ROLE_CREDENTIAL_VCT } from '../core/types'
import { loadState } from '../seed/state'
import { OFFICER_CREDENTIAL } from '../shared/demo-config'
import { identityServiceFromEnv, IdentityServiceClient } from '../shared/identity-service'
import {
  authorizedResult,
  deniedResult,
  NO_PRESENTATION_IN_TIME,
  requestedFromDefinition,
} from '../shared/authorization-result'
import {
  assertPresentedCredentialValid,
  PresentationRefused,
  PresentedCredential,
  readPresentedCredential,
  StatusCheck,
  statusListOriginOf,
} from '../shared/presented-credential'
import {
  IN_TASK_OID4VP_EXTENSION_URI,
  InTaskOpenId4VpAuthorizationRequest,
  InTaskOpenId4VpAuthorizationResult,
  InTaskOpenId4VpAuthorizationStatus,
  InTaskOpenId4VpExtension,
  InTaskOpenId4VpMessageMetadata,
} from './extension'
import { prepareInvoiceReport, SENSITIVE_STEP } from './invoice-work'

dotenv.config()

const PORT = Number(process.env.ACME_AGENT_PORT ?? 10003)
/**
 * Advertised in the agent card, which is what A2A clients actually connect to — so it must be
 * reachable from the client, not just from here (they are different hosts under Docker).
 */
const PUBLIC_URL = process.env.ACME_AGENT_PUBLIC_URL ?? `http://localhost:${PORT}/`
/** Long enough for a human to pick up a phone, scan and consent. */
const AUTHORIZATION_TIMEOUT_MS = Number(process.env.AGENT_AUTH_TIMEOUT_MS ?? 180_000)

/** Ask for the officer credential, disclosing only role and organisation. */
const OFFICER_PRESENTATION_DEFINITION = {
  id: 'FinanceDataOfficer',
  name: 'Finance Data Officer',
  purpose: 'Authorize preparation of a supplier payment export',
  input_descriptors: [
    {
      id: 'FinanceDataOfficer',
      name: 'Finance Data Officer credential',
      purpose: 'Confirms the human authorizing this step holds the finance data officer role',
      constraints: {
        limit_disclosure: 'required',
        fields: [
          { path: ['$.vct'], filter: { type: 'string', enum: [ROLE_CREDENTIAL_VCT] } },
          { path: ['$.role'], filter: { type: 'string', enum: [OFFICER_CREDENTIAL.role] } },
          { path: ['$.org'], filter: { type: 'string' } },
        ],
      },
    },
  ],
}

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

function agentCard(): AgentCard {
  return {
    name: 'Acme Invoice Agent',
    description: 'Autonomous supplier invoice reconciliation and payment preparation.',
    url: PUBLIC_URL,
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

class AuthorizationDenied extends Error {
  public constructor(
    message: string,
    /** What the client is told (demo addition); absent only when the denial has no session. */
    public readonly result?: InTaskOpenId4VpAuthorizationResult
  ) {
    super(message)
    this.name = 'AuthorizationDenied'
  }
}

class InvoiceAgentExecutor implements AgentExecutor {
  private readonly authorizedContexts = new Set<string>()
  private readonly sessionToContext = new Map<string, string>()
  /** Latest Heka state per session this agent opened — what `authorizationStatus` forwards. */
  private readonly sessionStates = new Map<string, string>()
  private readonly cancelled = new Set<string>()

  private verifierDid: string | null = null

  public constructor(private readonly identityService: IdentityServiceClient) {}

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
    const socket = new WebSocket(this.identityService.notificationsUrl(), {
      headers: { Authorization: `Bearer ${process.env.IDENTITY_SERVICE_ACCESS_TOKEN}` },
    })
    socket.on('open', () => console.log('[agent] notification channel open'))
    socket.on('error', (error: Error) => console.log(`[agent] notification error: ${error.message}`))
    socket.on('message', (raw: Buffer) => this.onNotification(raw))
    socket.on('close', (code: number) => {
      console.log(`[agent] notification channel closed (${code}); reconnecting in 3s`)
      setTimeout(() => this.connectNotifications(), 3000)
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
    if (!this.sessionToContext.has(session.id)) return
    console.log(`[agent] session ${session.id.slice(0, 8)} -> ${session.state}`)
    if (session.state) this.sessionStates.set(session.id, session.state)
  }

  public cancelTask = async (taskId: string): Promise<void> => {
    this.cancelled.add(taskId)
  }

  public async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const userMessage = context.userMessage
    const taskId = context.task?.id ?? randomUUID()
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
    }

    const say = (state: 'working' | 'auth-required' | 'completed' | 'failed', text: string, extra?: object) => {
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
    }

    // Set only when this task ran the authorization itself; a context authorized earlier has none.
    let result: InTaskOpenId4VpAuthorizationResult | undefined

    try {
      say('working', 'Reconciling supplier invoices for the period…')

      // Routine work needs no authorization; only the export does.
      if (!this.authorizedContexts.has(contextId)) {
        say('working', `Reconciliation complete. ${SENSITIVE_STEP} requires authorization.`)

        const { request, sessionId } = await this.requestAuthorization(contextId)
        // The agent's own deadline; the verifier session has a shorter lifetime Heka does not expose.
        const expiresAt = new Date(Date.now() + AUTHORIZATION_TIMEOUT_MS).toISOString()
        const statusOf = (state: string): InTaskOpenId4VpAuthorizationStatus => ({
          sessionId,
          state,
          expiresAt,
          requested: OFFICER_REQUESTED,
        })

        say('auth-required', 'Present a Finance Data Officer credential to authorize the payment export.', {
          metadata: withExtension({ authorizationRequest: request, authorizationStatus: statusOf('RequestCreated') }),
        })

        const { presented, status } = await this.awaitAuthorization(sessionId, contextId, expiresAt, (state) => {
          const text = SESSION_STATE_TEXT[state]
          if (text) say('working', text, { metadata: withExtension({ authorizationStatus: statusOf(state) }) })
        })
        result = authorizedResult(presented, status)
        say('working', 'Authorization accepted. Preparing the payment export…')
      }

      if (this.cancelled.has(taskId)) {
        say('failed', 'Task cancelled.')
        return
      }

      const report = await prepareInvoiceReport(collectText(context))
      say('completed', report, result ? { metadata: withExtension({ authorizationResult: result }) } : undefined)
    } catch (error) {
      const denied = error instanceof AuthorizationDenied
      console.log(`[agent] task ${taskId.slice(0, 8)} ${denied ? 'denied' : 'failed'}: ${(error as Error).message}`)
      const message = (error as Error).message
      say(
        'failed',
        denied ? `Authorization denied: ${message}` : `Agent error: ${message}`,
        denied && error.result ? { metadata: withExtension({ authorizationResult: error.result }) } : undefined
      )
    }
  }

  private async requestAuthorization(contextId: string) {
    const response = await this.identityService.createVerificationSession({
      publicVerifierId: this.verifierDid as string,
      requestSigner: { method: 'did', did: this.verifierDid as string },
      presentationExchange: { definition: OFFICER_PRESENTATION_DEFINITION },
    })

    const sessionId = response.verificationSession.id
    this.sessionToContext.set(sessionId, contextId)
    console.log(
      `[agent] authorization requested: session ${sessionId.slice(0, 8)} for context ${contextId.slice(0, 8)}`
    )

    return {
      sessionId,
      request: {
        client_id: this.verifierDid as string,
        request_uri: response.authorizationRequest,
      } as InTaskOpenId4VpAuthorizationRequest,
    }
  }

  private async awaitAuthorization(
    sessionId: string,
    contextId: string,
    expiresAt: string,
    onState: (state: string) => void
  ): Promise<{ presented: PresentedCredential; status: StatusCheck }> {
    await this.waitForVerifiedPresentation(sessionId, Date.parse(expiresAt), onState)

    // Heka verified the signature and the key binding. Whether this relying party accepts the
    // credential — its issuer, its type, and whether it is still live — is decided here, against
    // the presented token itself. Never against a seed slot: the slot says what was issued, the
    // token says what was shown.
    const trustedIssuer = loadState().issuerDid
    if (!trustedIssuer) throw new AuthorizationDenied('no trusted issuer configured — run `yarn seed`')

    // Declared outside the try so a refusal can still log which status pointer it was judged on.
    let presented: PresentedCredential | undefined
    try {
      presented = readPresentedCredential(await this.identityService.getVerificationSession(sessionId))
      const status = await assertPresentedCredentialValid(
        presented,
        {
          trustedIssuers: [trustedIssuer],
          requiredVct: ROLE_CREDENTIAL_VCT,
          statusListOrigin: this.identityService.baseOrigin,
          credentialLabel: OFFICER_CREDENTIAL.role,
          requiredClaims: { role: OFFICER_CREDENTIAL.role },
        },
        fetch
      )
      console.log(`[agent] status checked: index ${status.statusListIndex} on ${status.statusListCredential} -> live`)

      this.authorizedContexts.add(contextId)
      console.log(`[agent] context ${contextId.slice(0, 8)} authorized`)
      return { presented, status }
    } catch (error) {
      if (error instanceof PresentationRefused) {
        if (error.reason === 'revoked' && presented?.credentialStatus) {
          const { statusListIndex, statusListCredential } = presented.credentialStatus
          console.log(`[agent] status checked: index ${statusListIndex} on ${statusListCredential} -> revoked`)
        }
        if (error.reason === 'foreign-status-list' && presented?.credentialStatus) {
          const origin = statusListOriginOf(presented.credentialStatus) ?? '(not a URL)'
          console.log(`[agent] status list origin ${origin} is not ${this.identityService.baseOrigin}`)
        }
        console.log(`[agent] presentation refused (${error.reason}): ${error.message}`)
        throw new AuthorizationDenied(error.message, deniedResult(sessionId, error.message, presented, error.reason))
      }
      throw error
    }
  }

  /**
   * Resolve once Heka reports `ResponseVerified`, calling `onState` on every state change on the
   * way (the wallet fetching the request is the first sign of life the operator can see). The
   * WebSocket is the fast path; every few seconds Heka is asked directly in case a notification
   * fell into a reconnect gap.
   */
  private waitForVerifiedPresentation(
    sessionId: string,
    deadline: number,
    onState: (state: string) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let reported = 'RequestCreated'
      let ticks = 0
      let checking = false
      const poll = setInterval(async () => {
        const state = this.sessionStates.get(sessionId)
        if (state && state !== reported) {
          reported = state
          onState(state)
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
            if (session.state) this.sessionStates.set(sessionId, session.state)
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

async function main() {
  const identityService = identityServiceFromEnv()

  const executor = new InvoiceAgentExecutor(identityService)
  await executor.initialize()

  const handler = new DefaultRequestHandler(agentCard(), new InMemoryTaskStore() as TaskStore, executor)
  const app = new A2AExpressApp(handler).setupRoutes(express())

  app.listen(PORT, () => {
    console.log(`[agent] Acme Invoice Agent on http://localhost:${PORT}`)
    console.log(`[agent] agent card: http://localhost:${PORT}/.well-known/agent-card.json`)
  })
}

main().catch((error) => {
  console.error('[agent] FATAL', error?.response?.data ?? error?.message ?? error)
  process.exit(1)
})
