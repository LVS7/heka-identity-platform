import { describe, expect, it } from 'vitest'

import { presentationFrom, sourceOf, toAuthorizationState } from '../presentation'

describe('toAuthorizationState', () => {
  it('maps the three Heka states the strip shows and treats anything else as still requested', () => {
    expect(toAuthorizationState('RequestCreated')).toBe('requested')
    expect(toAuthorizationState('RequestUriRetrieved')).toBe('wallet-fetched')
    expect(toAuthorizationState('ResponseVerified')).toBe('verified')
    expect(toAuthorizationState('Error')).toBe('requested')
  })
})

describe('sourceOf', () => {
  const authorized = { sessionId: 's', outcome: 'authorized' as const, vpToken: 'ey…' }
  const timedOut = { sessionId: 's', outcome: 'denied' as const, reason: 'no presentation was received in time' }

  it('keeps what the Trust Lens recorded when a button was pressed', () => {
    expect(sourceOf({ request: 'openid4vp://', state: 'verified', source: 'wallet' }, authorized)).toBe('wallet')
    expect(sourceOf({ request: 'openid4vp://', state: 'verified', source: 'simulated' }, authorized)).toBe('simulated')
  })

  it('infers a scan when a token arrived and nothing was pressed', () => {
    expect(sourceOf({ request: 'openid4vp://', state: 'verified' }, authorized)).toBe('qr')
  })

  it('is unknown when nothing was presented at all', () => {
    expect(sourceOf({ request: 'openid4vp://', state: 'requested' }, timedOut)).toBe('unknown')
    expect(sourceOf(undefined, timedOut)).toBe('unknown')
  })
})

describe('presentationFrom', () => {
  it('attaches the source to the relying party’s result', () => {
    expect(presentationFrom({ sessionId: 's', outcome: 'authorized' }, 'qr')).toEqual({
      sessionId: 's',
      outcome: 'authorized',
      source: 'qr',
    })
  })
})
