import { describe, expect, it } from 'vitest'

import { AuditLog } from '../audit'

describe('AuditLog', () => {
  it('records an event with its evidence and returns it', () => {
    const log = new AuditLog()
    const event = log.record('verification', 'Acme Invoice Agent', 'VERIFIED', { issuerTrusted: true })

    expect(event).toMatchObject({ type: 'verification', subject: 'Acme Invoice Agent', outcome: 'VERIFIED' })
    expect(event.evidence).toEqual({ issuerTrusted: true })
    expect(event.id).toBeTruthy()
    expect(Date.parse(event.timestamp)).not.toBeNaN()
  })

  it('lists newest first so the timeline reads top-down', () => {
    const log = new AuditLog()
    log.record('verification', 'first', 'VERIFIED')
    log.record('verification', 'second', 'VERIFIED')

    expect(log.list().map((event) => event.subject)).toEqual(['second', 'first'])
  })

  it('filters by type and honours a limit', () => {
    const log = new AuditLog()
    log.record('verification', 'agent', 'VERIFIED')
    log.record('revocation', 'mcp passport', 'REVOKED')
    log.record('engagement_refused', 'lookalike', 'SUBJECT_MISMATCH')

    expect(log.list({ type: 'revocation' })).toHaveLength(1)
    expect(log.list({ limit: 2 })).toHaveLength(2)
  })

  it('looks an entry up by id so receipts can deep-link into it', () => {
    const log = new AuditLog()
    const event = log.record('authorization', 'operator', 'presented Finance Data Officer')

    expect(log.get(event.id)?.subject).toBe('operator')
    expect(log.get('missing')).toBeUndefined()
  })

  it('keeps every entry rather than replacing repeats of the same subject', () => {
    const log = new AuditLog()
    log.record('verification', 'agent', 'VERIFIED')
    log.record('verification', 'agent', 'REVOKED')

    expect(log.size).toBe(2)
    expect(log.list().map((event) => event.outcome)).toEqual(['REVOKED', 'VERIFIED'])
  })
})
