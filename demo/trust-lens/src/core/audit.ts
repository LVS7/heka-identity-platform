/**
 * Audit log — the demo's non-repudiation surface.
 *
 * Every trust decision is recorded with the evidence it was based on: what was verified,
 * who authorized what, what was refused and why. Append-only; entries are never rewritten,
 * because an audit trail you can edit is not an audit trail.
 *
 * In-memory for the demo. A deployment would persist this.
 */

import { randomUUID } from 'node:crypto'

import { AuditEvent, AuditEventType } from './types'

export class AuditLog {
  private readonly events: AuditEvent[] = []

  public record(type: AuditEventType, subject: string, outcome: string, evidence?: unknown): AuditEvent {
    const event: AuditEvent = {
      id: randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      subject,
      outcome,
      evidence,
    }
    this.events.push(event)
    return event
  }

  /** Newest first, optionally filtered by type. */
  public list(filter?: { type?: AuditEventType; limit?: number }): AuditEvent[] {
    const matching = filter?.type ? this.events.filter((event) => event.type === filter.type) : [...this.events]
    const newestFirst = matching.reverse()
    return filter?.limit ? newestFirst.slice(0, filter.limit) : newestFirst
  }

  public get(id: string): AuditEvent | undefined {
    return this.events.find((event) => event.id === id)
  }

  public get size(): number {
    return this.events.length
  }
}
