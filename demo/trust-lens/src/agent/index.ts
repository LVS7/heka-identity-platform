/**
 * Acme Invoice Agent — an A2A server whose sensitive step requires a verifiable
 * authorization from a human, over the published OID4VP In-Task Auth extension.
 *
 * The shape of the demo: the agent works happily until it reaches the payment export, then
 * pauses in `auth-required` carrying an OID4VP request. It resumes only once the operator has
 * presented a Finance Data Officer credential — disclosing role and organisation, nothing else.
 *
 * One addition over the reference demo, and it is the point of Part IV: Heka's verifier
 * confirms the presentation is cryptographically sound but does **not** consult the issuer's
 * status list. So after a valid presentation this agent checks revocation itself. Without that,
 * revoking the officer credential would not actually deny anything.
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

import { checkCredentialStatus } from '../core/status-list'
import { ROLE_CREDENTIAL_VCT } from '../core/types'
import { loadState } from '../seed/state'
import { OFFICER_CREDENTIAL } from '../shared/demo-config'
import { identityServiceFromEnv, IdentityServiceClient } from '../shared/identity-service'
import {
  IN_TASK_OID4VP_EXTENSION_URI,
  InTaskOpenId4VpAuthorizationRequest,
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
          { path: ['$.role'], filter: { type: 'string' } },
          { path: ['$.org'], filter: { type: 'string' } },
        ],
      },
    },
  ],
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

class AuthorizationDenied extends Error {}

class InvoiceAgentExecutor implements AgentExecutor {
  private readonly authorizedContexts = new Set<string>()
  private readonly sessionToContext = new Map<string, string>()
  private readonly verifiedSessions = new Set<string>()
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

    console.log(`[agent] session ${session.id.slice(0, 8)} -> ${session.state}`)
    if (session.state === 'ResponseVerified') this.verifiedSessions.add(session.id)
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

    try {
      say('working', 'Reconciling supplier invoices for the period…')

      // Routine work needs no authorization; only the export does.
      if (!this.authorizedContexts.has(contextId)) {
        say('working', `Reconciliation complete. ${SENSITIVE_STEP} requires authorization.`)

        const { request, sessionId } = await this.requestAuthorization(contextId)
        say('auth-required', 'Present a Finance Data Officer credential to authorize the payment export.', {
          metadata: {
            [IN_TASK_OID4VP_EXTENSION_URI]: { authorizationRequest: request } satisfies InTaskOpenId4VpMessageMetadata,
          },
        })

        await this.awaitAuthorization(sessionId, contextId)
        say('working', 'Authorization accepted. Preparing the payment export…')
      }

      if (this.cancelled.has(taskId)) {
        say('failed', 'Task cancelled.')
        return
      }

      const report = await prepareInvoiceReport(collectText(context))
      say('completed', report)
    } catch (error) {
      const denied = error instanceof AuthorizationDenied
      console.log(`[agent] task ${taskId.slice(0, 8)} ${denied ? 'denied' : 'failed'}: ${(error as Error).message}`)
      say(
        'failed',
        denied ? `Authorization denied: ${(error as Error).message}` : `Agent error: ${(error as Error).message}`
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

  private async awaitAuthorization(sessionId: string, contextId: string): Promise<void> {
    await this.waitForVerifiedPresentation(sessionId)

    // The presentation is cryptographically valid. That is not the same as currently
    // authorized: Heka's verifier does not consult the issuer's status list, so a revoked
    // credential would still verify. Check revocation before letting the task proceed.
    await this.assertCredentialNotRevoked()

    this.authorizedContexts.add(contextId)
    console.log(`[agent] context ${contextId.slice(0, 8)} authorized`)
  }

  private waitForVerifiedPresentation(sessionId: string): Promise<void> {
    if (this.verifiedSessions.has(sessionId)) return Promise.resolve()

    return new Promise((resolve, reject) => {
      const started = Date.now()
      let ticks = 0
      let checking = false
      const poll = setInterval(async () => {
        if (this.verifiedSessions.has(sessionId)) {
          clearInterval(poll)
          resolve()
          return
        }
        if (Date.now() - started > AUTHORIZATION_TIMEOUT_MS) {
          clearInterval(poll)
          reject(new AuthorizationDenied('no presentation was received in time'))
          return
        }
        // Belt and braces: every few seconds, ask Heka in case the notification never came.
        if (++ticks % 6 === 0 && !checking) {
          checking = true
          try {
            const session = await this.identityService.getVerificationSession(sessionId)
            if (session.state === 'ResponseVerified') this.verifiedSessions.add(sessionId)
          } catch {
            // Transient; the next tick tries again and the timeout still bounds the wait.
          } finally {
            checking = false
          }
        }
      }, 500)
    })
  }

  private async assertCredentialNotRevoked(): Promise<void> {
    const state = loadState()
    const statusListId = state.statusListId
    const index = state.statusIndexes.officer

    if (!statusListId || index === undefined) {
      console.log('[agent] no status pointer in seed state; skipping the revocation check')
      return
    }

    const revoked = await checkCredentialStatus(
      { statusListCredential: this.identityService.statusListUrl(statusListId), statusListIndex: index },
      fetch
    )

    if (revoked) {
      throw new AuthorizationDenied(`the ${OFFICER_CREDENTIAL.role} credential has been revoked by its issuer`)
    }
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
