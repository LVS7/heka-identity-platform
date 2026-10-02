/**
 * A2A engagement, from the orchestrator's side.
 *
 * Streams a task with the agent and keeps the progress so the UI can poll it. When the agent
 * pauses in `auth-required`, the OID4VP request it carries is surfaced for the operator — pushed
 * to Heka Wallet over DIDComm, shown as a QR, or handed to the in-process simulated holder — and
 * everything the agent says about the presentation afterwards (demo additions to the extension,
 * see src/agent/extension.ts) is kept on the task and in the audit.
 */

import { A2AClient } from '@a2a-js/sdk/client'
import { AgentCard, Message, MessageSendParams, Task, TaskStatusUpdateEvent } from '@a2a-js/sdk'
import { randomUUID } from 'node:crypto'

import { AuditLog } from '../core/audit'
import { IdentityServiceClient } from '../shared/identity-service'
import { NO_PRESENTATION_IN_TIME } from '../shared/authorization-result'
import { SimulatedWallet } from '../shared/simulated-wallet'
import { IN_TASK_OID4VP_EXTENSION_URI, InTaskOpenId4VpMessageMetadata } from '../agent/extension'
import { AuthorizationView, presentationFrom, PresentationView, sourceOf, toAuthorizationState } from './presentation'
import { DeliveryState, deliverToWallet } from './wallet-delivery'

export interface TaskEvent {
  at: string
  state: string
  text?: string
}

export interface TrackedTask {
  id: string
  /** The catalog entry it was engaged from — what "Run again in this context" engages again. */
  identifier: string
  publisher: string
  resource: string
  state: string
  startedAt: string
  events: TaskEvent[]
  /** The agent's own identifiers, from the first stream event. */
  a2a?: { taskId: string; contextId: string }
  /** The verification the Trust Lens ran at engagement time — the verdict the browser held is never trusted. */
  preflight?: { verdict: string; auditId: string; verifiedAt: string }
  /** From `auth-required` on; its state follows the verifier session, then the outcome. */
  authorization?: AuthorizationView
  /** What was verified (or refused), with the source only this side knows. */
  presentation?: PresentationView
  result?: string
  error?: string
}

const FINAL_STATES = ['authorized', 'denied', 'expired', 'failed']

function extensionMetadata(update: TaskStatusUpdateEvent): InTaskOpenId4VpMessageMetadata | undefined {
  return update.status.message?.metadata?.[IN_TASK_OID4VP_EXTENSION_URI] as InTaskOpenId4VpMessageMetadata | undefined
}

/**
 * Fold one status update into the task. Pure — the audit side effects live in `consume` — and
 * exported so the folding can be tested without an agent.
 */
export function applyStatusUpdate(task: TrackedTask, update: TaskStatusUpdateEvent): { text?: string } {
  const text = update.status.message?.parts
    ?.filter((part) => part.kind === 'text')
    .map((part) => (part as { text: string }).text)
    .join(' ')

  task.state = update.status.state
  task.events.push({ at: update.status.timestamp ?? new Date().toISOString(), state: update.status.state, text })

  const metadata = extensionMetadata(update)
  const status = metadata?.authorizationStatus
  const result = metadata?.authorizationResult

  if (update.status.state === 'auth-required' && metadata?.authorizationRequest) {
    task.authorization = {
      request: metadata.authorizationRequest.request_uri,
      clientId: metadata.authorizationRequest.client_id,
      sessionId: status?.sessionId,
      state: status ? toAuthorizationState(status.state) : 'requested',
      expiresAt: status?.expiresAt,
      requested: status?.requested,
    }
  } else if (status && task.authorization && !FINAL_STATES.includes(task.authorization.state)) {
    task.authorization.state = toAuthorizationState(status.state)
    // The wallet moved and nobody pressed Send or Simulate here: the request was scanned.
    if (task.authorization.state !== 'requested' && !task.authorization.source) task.authorization.source = 'qr'
  }

  if (update.status.state === 'completed') {
    task.result = text
    if (task.authorization) task.authorization.state = 'authorized'
    if (result) task.presentation = presentationFrom(result, sourceOf(task.authorization, result))
  }

  if (update.status.state === 'failed') {
    task.error = text
    // Denied or expired only with the agent's result; without one the agent failed, and nobody refused anything.
    if (task.authorization) {
      task.authorization.state = !result ? 'failed' : result.reason === NO_PRESENTATION_IN_TIME ? 'expired' : 'denied'
    }
    if (result) task.presentation = presentationFrom(result, sourceOf(task.authorization, result))
  }

  return { text }
}

/** What the tracker needs from an A2A client — the SDK's, or a stand-in in tests. */
type A2AStreamClient = Pick<A2AClient, 'sendMessageStream'>

export interface TaskTrackerOptions {
  /** The agent's URL from the environment; used only when the verified card is not at hand. */
  agentUrl: string
  client?: (card: AgentCard | string) => A2AStreamClient
}

export class TaskTracker {
  private readonly tasks = new Map<string, TrackedTask>()
  private wallet: SimulatedWallet | undefined
  private readonly client: (card: AgentCard | string) => A2AStreamClient

  public constructor(
    private readonly audit: AuditLog,
    private readonly identityService: IdentityServiceClient,
    private readonly options: TaskTrackerOptions
  ) {
    this.client = options.client ?? ((card) => new A2AClient(card))
  }

  public get(id: string): TrackedTask | undefined {
    return this.tasks.get(id)
  }

  /** Newest first, like the audit: the engagement you just started is the one you look for. */
  public list(): TrackedTask[] {
    return [...this.tasks.values()].reverse()
  }

  /** True while the operator can still present against this task. */
  public awaitingPresentation(
    task: TrackedTask | undefined
  ): task is TrackedTask & { authorization: AuthorizationView } {
    return Boolean(task?.authorization && !FINAL_STATES.includes(task.authorization.state))
  }

  /**
   * Start a task with the agent. `target.card` is the card that was just verified: the client talks
   * to the URL in those bytes rather than fetching the agent's live, unattested card again.
   * `contextId` continues an earlier conversation, which the agent may have authorized already.
   */
  public async start(
    target: { identifier: string; publisher: string; resource: string; card?: AgentCard },
    prompt: string,
    preflight?: TrackedTask['preflight'],
    contextId?: string
  ): Promise<TrackedTask> {
    const client = this.client(target.card ?? this.options.agentUrl)
    const task: TrackedTask = {
      id: randomUUID(),
      identifier: target.identifier,
      publisher: target.publisher,
      resource: target.resource,
      state: 'submitted',
      startedAt: new Date().toISOString(),
      events: [],
      preflight,
    }
    this.tasks.set(task.id, task)

    const message: Message = {
      messageId: randomUUID(),
      kind: 'message',
      role: 'user',
      parts: [{ kind: 'text', text: prompt }],
      ...(contextId ? { contextId } : {}),
    }

    // Consume the stream in the background; the UI polls this task.
    void this.consume(client, { message } as MessageSendParams, task)
    return task
  }

  private async consume(client: A2AStreamClient, params: MessageSendParams, task: TrackedTask): Promise<void> {
    try {
      for await (const event of client.sendMessageStream(params)) {
        if (event.kind === 'task') {
          const agentTask = event as Task
          task.state = agentTask.status.state
          task.a2a = { taskId: agentTask.id, contextId: agentTask.contextId }
          continue
        }
        if (event.kind !== 'status-update') continue

        const update = event as TaskStatusUpdateEvent
        const { text } = applyStatusUpdate(task, update)
        const state = update.status.state

        if (state === 'auth-required') {
          this.audit.record('authorization', task.resource, 'authorization requested', {
            step: text,
            via: 'OID4VP In-Task Auth extension',
            sessionId: task.authorization?.sessionId,
          })
        }

        // The presentation is the evidence: it goes into the audit with the decision it settled.
        if (state === 'completed') {
          if (task.authorization) {
            this.audit.record(
              'authorization',
              task.resource,
              'task completed after verified presentation',
              task.presentation ? { presentation: task.presentation } : undefined
            )
          } else {
            // Nothing was presented in this task: the agent had authorized its context before.
            this.audit.record('authorization', task.resource, 'task completed in a context authorized earlier', {
              contextId: task.a2a?.contextId,
            })
          }
        }

        if (state === 'failed') {
          // A refused or expired presentation is a decision; anything else is the agent failing.
          const decided = task.authorization?.state === 'denied' || task.authorization?.state === 'expired'
          if (decided) {
            this.audit.record(
              'denial',
              task.resource,
              text ?? 'task failed',
              task.presentation ? { presentation: task.presentation } : undefined
            )
          } else {
            this.audit.record('engagement_refused', task.resource, 'UNAVAILABLE', { reason: text ?? 'task failed' })
          }
        }
      }
    } catch (error) {
      task.state = 'failed'
      task.error = (error as Error).message
      // The stream broke (the agent went down or restarted): nobody decided anything about a credential.
      this.audit.record('engagement_refused', task.resource, 'UNAVAILABLE', { reason: task.error })
    }
  }

  /** Push the pending request to the operator's wallet; the outcome is kept on the task. */
  public async sendToWallet(
    task: TrackedTask & { authorization: AuthorizationView },
    deliver: (content: string) => Promise<void>
  ): Promise<DeliveryState> {
    const { authorization } = task
    authorization.source = 'wallet'
    authorization.delivery = await deliverToWallet({
      subject: task.resource,
      content: authorization.request,
      deliver,
      audit: this.audit,
      previous: authorization.delivery,
    })
    return authorization.delivery
  }

  /** Present the officer credential against any OID4VP request — the agent's or the AS's. */
  public async presentToAuthorizationServer(authorizationRequest: string): Promise<void> {
    this.wallet ??= new SimulatedWallet(this.identityService)
    // `present` brings the holder up, and re-mints its credential if the seed changed since.
    await this.wallet.present(authorizationRequest)
  }

  public async simulatePresentation(task: TrackedTask & { authorization: AuthorizationView }): Promise<void> {
    // Set before presenting: the agent's next update may land before `present` returns.
    task.authorization.source = 'simulated'
    await this.presentToAuthorizationServer(task.authorization.request)

    this.audit.record('authorization', task.resource, 'presentation submitted (simulated holder)', {
      note: 'in-process holder, not the operator’s phone',
    })
  }
}
