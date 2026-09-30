/**
 * What the server view reads: a task index, the authorization records, the channel's health and
 * the authorized-context cache — fed by the executor at the points where it already logs, and
 * journaled as it goes.
 *
 * Kept apart from the A2A task store on purpose. `InMemoryTaskStore` cannot list, and the page
 * wants the agent's own reading of what happened — a step per status update, the verifier
 * session's progress, the status check it ran — rather than the SDK's task object.
 */

import { InTaskOpenId4VpAuthorizationResult } from './extension'
import { AgentJournal } from './journal'
import { StatusCheck } from '../shared/presented-credential'

export interface TaskStep {
  at: string
  state: string
  text?: string
}

export interface TaskView {
  id: string
  contextId: string
  state: string
  startedAt: string
  updatedAt: string
  steps: TaskStep[]
  sessionId?: string
  result?: string
  error?: string
}

/**
 * What was verified, minus the token: the compact VP stays with the Trust Lens audit. Built from
 * the same result the client receives, so a denial carries no claims here either — nothing was
 * authorized, so nothing was disclosed to anyone.
 */
export type PresentationSummary = Pick<
  InTaskOpenId4VpAuthorizationResult,
  'claims' | 'issuer' | 'holder' | 'credentialType' | 'verifiedAt'
>

export interface AuthorizationRecord {
  sessionId: string
  taskId: string
  contextId: string
  requestedAt: string
  /** Heka's verification-session state as last seen (RequestCreated → RequestUriRetrieved → ResponseVerified). */
  sessionState: string
  /** The agent's own deadline, not the session's lifetime. */
  expiresAt: string
  verifiedAt?: string
  presentation?: PresentationSummary
  status?: StatusCheck
  outcome?: 'authorized' | 'denied'
  reason?: string
  decidedAt?: string
}

export interface ChannelView {
  state: 'connecting' | 'open' | 'closed'
  since: string
  reconnects: number
  lastError?: string
}

const ids = (record: Pick<AuthorizationRecord, 'taskId' | 'contextId' | 'sessionId'>) => ({
  taskId: record.taskId,
  contextId: record.contextId,
  sessionId: record.sessionId,
})

export class AgentState {
  public readonly journal: AgentJournal
  public readonly tasks = new Map<string, TaskView>()
  public readonly authorizations = new Map<string, AuthorizationRecord>()
  /** Contexts whose sensitive step was authorized once; a later task in one of them skips the request. */
  public readonly authorizedContexts = new Set<string>()
  public channel: ChannelView = { state: 'connecting', since: new Date().toISOString(), reconnects: 0 }
  private opens = 0

  public constructor(journal = new AgentJournal()) {
    this.journal = journal
  }

  // ---------- tasks ----------

  public taskStep(taskId: string, contextId: string, state: string, text?: string): void {
    const at = new Date().toISOString()
    let task = this.tasks.get(taskId)
    if (!task) {
      task = { id: taskId, contextId, state, startedAt: at, updatedAt: at, steps: [] }
      this.tasks.set(taskId, task)
    }
    task.state = state
    task.updatedAt = at
    task.steps.push({ at, state, text })
    if (state === 'completed') task.result = text
    if (state === 'failed') task.error = text
    this.journal.record({ type: 'task.state', taskId, contextId, text: text ? `${state}: ${text}` : state })
  }

  /** Newest first: the task you just started is the one you look for. */
  public listTasks(): TaskView[] {
    return [...this.tasks.values()].reverse()
  }

  // ---------- authorizations ----------

  public authorizationRequested(
    record: Pick<AuthorizationRecord, 'sessionId' | 'taskId' | 'contextId' | 'expiresAt'>
  ): void {
    this.authorizations.set(record.sessionId, {
      ...record,
      requestedAt: new Date().toISOString(),
      sessionState: 'RequestCreated',
    })
    const task = this.tasks.get(record.taskId)
    if (task) task.sessionId = record.sessionId
    this.journal.record({
      type: 'auth.requested',
      ...ids(record),
      text: `authorization requested; the agent waits until ${record.expiresAt}`,
      data: { expiresAt: record.expiresAt },
    })
  }

  /**
   * Only sessions this agent opened are known here; the AS's sessions on the shared tenant never
   * reach this method with a record and are dropped. A repeated state is not a change.
   */
  public sessionState(sessionId: string, state: string): void {
    const record = this.authorizations.get(sessionId)
    if (!record || record.sessionState === state) return
    record.sessionState = state
    this.journal.record({ type: 'session.state', ...ids(record), text: `session ${state}` })
    if (state === 'ResponseVerified') {
      record.verifiedAt = new Date().toISOString()
      this.journal.record({
        type: 'auth.verified',
        ...ids(record),
        text: 'presentation verified by Heka; the agent now judges the credential itself',
      })
    }
  }

  public statusChecked(sessionId: string, status: StatusCheck): void {
    const record = this.authorizations.get(sessionId)
    if (!record) return
    record.status = status
    this.journal.record({
      type: 'status.checked',
      ...ids(record),
      text: `status list index ${status.statusListIndex} -> ${status.revoked ? 'revoked' : 'live'}`,
      data: {
        statusListCredential: status.statusListCredential,
        statusListIndex: status.statusListIndex,
        revoked: status.revoked,
      },
    })
  }

  /** The decision, from the same result the client is told — one rule for both sides. */
  public authorizationDecided(result: InTaskOpenId4VpAuthorizationResult): void {
    const record = this.authorizations.get(result.sessionId)
    if (!record) return
    record.outcome = result.outcome
    record.reason = result.reason
    record.decidedAt = new Date().toISOString()
    if (result.status && !record.status) record.status = result.status
    if (result.issuer || result.holder || result.credentialType) {
      record.presentation = {
        claims: result.claims,
        issuer: result.issuer,
        holder: result.holder,
        credentialType: result.credentialType,
        verifiedAt: result.verifiedAt,
      }
    }

    if (result.outcome === 'authorized') {
      this.authorizedContexts.add(record.contextId)
      const claims = Object.entries(result.claims ?? {})
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(', ')
      this.journal.record({
        type: 'auth.authorized',
        ...ids(record),
        text: `authorized${claims ? ` (${claims})` : ''}; context ${record.contextId.slice(0, 8)} remembered`,
        data: { claims: result.claims, issuer: result.issuer, holder: result.holder },
      })
      return
    }
    this.journal.record({
      type: 'auth.denied',
      ...ids(record),
      text: `denied: ${result.reason ?? 'no reason given'}`,
      data: { reason: result.reason, issuer: result.issuer, holder: result.holder },
    })
  }

  /** True once the record is settled; a pending one is still being waited on. */
  public isDecided(sessionId: string): boolean {
    return Boolean(this.authorizations.get(sessionId)?.outcome)
  }

  public listAuthorizations(): AuthorizationRecord[] {
    return [...this.authorizations.values()].reverse()
  }

  /** Returns how many contexts were forgotten; the next task in each will ask again. */
  public forgetAuthorizations(): number {
    const cleared = this.authorizedContexts.size
    this.authorizedContexts.clear()
    this.journal.record({
      type: 'authorizations.cleared',
      text: `${cleared} authorized context${cleared === 1 ? '' : 's'} forgotten; the next task in each asks again`,
      data: { cleared },
    })
    return cleared
  }

  public counts(): { tasks: number; authorized: number; denied: number; contexts: number } {
    const records = [...this.authorizations.values()]
    return {
      tasks: this.tasks.size,
      authorized: records.filter((record) => record.outcome === 'authorized').length,
      denied: records.filter((record) => record.outcome === 'denied').length,
      contexts: this.authorizedContexts.size,
    }
  }

  // ---------- channel ----------

  public channelState(state: ChannelView['state'], detail?: string): void {
    const since = new Date().toISOString()
    if (state === 'open') {
      this.opens++
      this.channel = { state, since, reconnects: this.opens - 1 }
      this.journal.record({ type: 'channel.open', text: 'notification channel open' })
      return
    }
    this.channel = { ...this.channel, state, since }
    if (state === 'closed') {
      this.journal.record({
        type: 'channel.closed',
        text: `notification channel closed${detail ? ` (${detail})` : ''}`,
        data: { detail },
      })
    }
  }

  /** Socket errors precede the close; kept for the page, not journaled — the close is the event. */
  public channelError(message: string): void {
    this.channel = { ...this.channel, lastError: message }
  }

  // ---------- llm ----------

  public llmFallback(taskId: string, contextId: string, reason: string): void {
    this.journal.record({
      type: 'llm.fallback',
      taskId,
      contextId,
      text: `LLM unavailable (${reason}); the deterministic report was used`,
      data: { reason },
    })
  }
}
