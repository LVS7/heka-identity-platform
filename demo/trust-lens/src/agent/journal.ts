/**
 * The agent's own journal: what it was asked, what it verified, what it refused.
 *
 * Distinct from the Trust Lens audit (src/core/audit.ts), which records the orchestrator's trust
 * decisions. This is the relying party's side of the same story — task steps, verifier-session
 * states, status checks, decisions and the health of the notification channel — kept in memory
 * for the server view and nothing else. A ring buffer, because a stand runs for hours and the
 * page only needs the recent past.
 */

import { randomUUID } from 'node:crypto'

export type AgentEventType =
  | 'task.state'
  | 'auth.requested'
  | 'session.state'
  | 'auth.verified'
  | 'status.checked'
  | 'auth.authorized'
  | 'auth.denied'
  | 'channel.open'
  | 'channel.closed'
  | 'llm.fallback'
  | 'authorizations.cleared'

export interface AgentEvent {
  id: string
  at: string
  type: AgentEventType
  taskId?: string
  contextId?: string
  sessionId?: string
  text: string
  data?: unknown
}

export class AgentJournal {
  private readonly events: AgentEvent[] = []

  public constructor(private readonly capacity = 500) {}

  public record(event: Omit<AgentEvent, 'id' | 'at'>): AgentEvent {
    const recorded: AgentEvent = { id: randomUUID(), at: new Date().toISOString(), ...event }
    this.events.push(recorded)
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity)
    return recorded
  }

  /**
   * Newest first. `since` is an event id: only what was recorded after it comes back, which is
   * what a poller wants. An unknown id — evicted, or from before a restart — returns everything,
   * so a stale poller catches up instead of going quiet.
   */
  public list(options: { since?: string; limit?: number } = {}): AgentEvent[] {
    const from = options.since ? this.events.findIndex((event) => event.id === options.since) + 1 : 0
    const newestFirst = this.events.slice(from).reverse()
    return options.limit ? newestFirst.slice(0, options.limit) : newestFirst
  }

  public get size(): number {
    return this.events.length
  }
}
