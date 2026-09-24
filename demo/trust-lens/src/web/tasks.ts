/**
 * A2A engagement, from the orchestrator's side.
 *
 * Streams a task with the agent and keeps the progress so the UI can poll it. When the agent
 * pauses in `auth-required`, the OID4VP request it carries is surfaced for the operator — pushed
 * to Heka Wallet over DIDComm, shown as a QR, or handed to the in-process simulated holder.
 */

import { A2AClient } from '@a2a-js/sdk/client'
import { Message, MessageSendParams, Task, TaskStatusUpdateEvent } from '@a2a-js/sdk'
import { randomUUID } from 'node:crypto'

import { AuditLog } from '../core/audit'
import { IdentityServiceClient } from '../shared/identity-service'
import { SimulatedWallet } from '../shared/simulated-wallet'
import { IN_TASK_OID4VP_EXTENSION_URI } from '../agent/extension'
import { DeliveryState, deliverToWallet } from './wallet-delivery'

export interface TaskEvent {
  at: string
  state: string
  text?: string
}

export interface TrackedTask {
  id: string
  resource: string
  state: string
  events: TaskEvent[]
  /** Present only while the agent is waiting for a presentation. */
  authorizationRequest?: string
  /** Last attempt to push the request to the operator's wallet, if any. */
  delivery?: DeliveryState
  result?: string
  error?: string
}

export class TaskTracker {
  private readonly tasks = new Map<string, TrackedTask>()
  private wallet: SimulatedWallet | undefined

  public constructor(
    private readonly agentUrl: string,
    private readonly audit: AuditLog,
    private readonly identityService: IdentityServiceClient
  ) {}

  public get(id: string): TrackedTask | undefined {
    return this.tasks.get(id)
  }

  public async start(resource: string, prompt: string): Promise<TrackedTask> {
    const client = new A2AClient(this.agentUrl)
    const task: TrackedTask = { id: randomUUID(), resource, state: 'submitted', events: [] }
    this.tasks.set(task.id, task)

    const message: Message = {
      messageId: randomUUID(),
      kind: 'message',
      role: 'user',
      parts: [{ kind: 'text', text: prompt }],
    }

    // Consume the stream in the background; the UI polls this task.
    void this.consume(client, { message } as MessageSendParams, task)
    return task
  }

  private async consume(client: A2AClient, params: MessageSendParams, task: TrackedTask): Promise<void> {
    try {
      for await (const event of client.sendMessageStream(params)) {
        if (event.kind === 'task') {
          task.state = (event as Task).status.state
          continue
        }
        if (event.kind !== 'status-update') continue

        const update = event as TaskStatusUpdateEvent
        const text = update.status.message?.parts
          ?.filter((part) => part.kind === 'text')
          .map((part) => (part as { text: string }).text)
          .join(' ')

        task.state = update.status.state
        task.events.push({ at: update.status.timestamp ?? new Date().toISOString(), state: update.status.state, text })

        if (update.status.state === 'auth-required') {
          const metadata = update.status.message?.metadata?.[IN_TASK_OID4VP_EXTENSION_URI] as
            { authorizationRequest?: { request_uri?: string } } | undefined
          task.authorizationRequest = metadata?.authorizationRequest?.request_uri
          this.audit.record('authorization', task.resource, 'authorization requested', {
            step: text,
            via: 'OID4VP In-Task Auth extension',
          })
        }

        if (update.status.state === 'completed') {
          task.result = text
          task.authorizationRequest = undefined
          task.delivery = undefined
          this.audit.record('authorization', task.resource, 'task completed after verified presentation')
        }

        if (update.status.state === 'failed') {
          task.error = text
          task.authorizationRequest = undefined
          task.delivery = undefined
          this.audit.record('denial', task.resource, text ?? 'task failed')
        }
      }
    } catch (error) {
      task.state = 'failed'
      task.error = (error as Error).message
      this.audit.record('denial', task.resource, task.error)
    }
  }

  /** Push the pending request to the operator's wallet; the outcome is kept on the task. */
  public async sendToWallet(task: TrackedTask, deliver: (content: string) => Promise<void>): Promise<DeliveryState> {
    task.delivery = await deliverToWallet({
      subject: task.resource,
      content: task.authorizationRequest as string,
      deliver,
      audit: this.audit,
      previous: task.delivery,
    })
    return task.delivery
  }

  /** Present the officer credential against any OID4VP request — the agent's or the AS's. */
  public async presentToAuthorizationServer(authorizationRequest: string): Promise<void> {
    if (!this.wallet) this.wallet = new SimulatedWallet(this.identityService)
    await this.wallet.initialize()
    await this.wallet.present(authorizationRequest)
  }

  public async simulatePresentation(task: TrackedTask): Promise<void> {
    if (!this.wallet) this.wallet = new SimulatedWallet(this.identityService)
    await this.wallet.initialize()
    await this.wallet.present(task.authorizationRequest as string)

    this.audit.record('authorization', task.resource, 'presentation submitted (simulated holder)', {
      note: 'in-process holder, not the operator’s phone',
    })
  }
}
