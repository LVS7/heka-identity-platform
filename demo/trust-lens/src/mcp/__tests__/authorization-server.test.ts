import { describe, expect, it } from 'vitest'

import { IdentityServiceClient } from '../../shared/identity-service'
import { AuthorizationServer, createAuthorizationApp } from '../authorization-server'
import { request } from './http'

/** Heka as far as the AS uses it; each test scripts what it needs. */
function fakeHeka(overrides: Partial<Record<keyof IdentityServiceClient, unknown>> = {}): IdentityServiceClient {
  return {
    baseOrigin: 'http://heka',
    prepareWallet: async () => 'did:key:verifier',
    createVerificationSession: async () => ({
      verificationSession: { id: 'sess-1', state: 'RequestCreated' },
      authorizationRequest: 'openid4vp://?request_uri=x',
    }),
    getVerificationSession: async () => ({ id: 'sess-1', state: 'RequestCreated' }),
    ...overrides,
  } as unknown as IdentityServiceClient
}

async function app(heka = fakeHeka()) {
  const as = new AuthorizationServer(heka, { issuer: 'http://as', tokenTtlSeconds: 300 })
  await as.initialize()
  return createAuthorizationApp(as)
}

const AUTHORIZE =
  '/authorize?client_id=c&redirect_uri=http%3A%2F%2Fclient%2Fcb&code_challenge=abc&code_challenge_method=S256' +
  '&scope=suppliers%3Aexport&resource=http%3A%2F%2Fmcp%2Fmcp'

describe('authorization server', () => {
  it('serves RFC 8414 metadata for its issuer', async () => {
    const res = await request(await app(), 'GET', '/.well-known/oauth-authorization-server')
    expect(res.status).toBe(200)
    expect(res.body.token_endpoint).toBe('http://as/token')
  })

  it('requires PKCE with S256', async () => {
    const res = await request(await app(), 'GET', '/authorize?redirect_uri=x&resource=y')
    expect(res.status).toBe(400)
  })

  it('answers 503 and keeps the request while Heka cannot be read', async () => {
    let fail = true
    const a = await app(
      fakeHeka({
        getVerificationSession: async () => {
          if (fail) throw new Error('connect ECONNREFUSED')
          return { id: 'sess-1', state: 'RequestCreated' }
        },
      })
    )
    const begun = await request(a, 'GET', AUTHORIZE)
    const outage = await request(a, 'GET', `/authorize/${String(begun.body.requestId)}`)
    expect(outage.status).toBe(503)
    expect(outage.body).toMatchObject({ error: 'temporarily_unavailable', error_description: 'connect ECONNREFUSED' })

    fail = false
    const later = await request(a, 'GET', `/authorize/${String(begun.body.requestId)}`)
    expect(later.body).toMatchObject({ status: 'pending' })
  })

  it('rejects a redirect_uri that is not a URL before any session is created', async () => {
    let created = 0
    const a = await app(
      fakeHeka({
        createVerificationSession: async () => {
          created++
          throw new Error('should not be called')
        },
      })
    )
    const res = await request(a, 'GET', AUTHORIZE.replace('http%3A%2F%2Fclient%2Fcb', 'foo'))
    expect(res.status).toBe(400)
    expect(created).toBe(0)
  })

  it('answers 404 for a request it does not know', async () => {
    const res = await request(await app(), 'GET', '/authorize/nope')
    expect(res.status).toBe(404)
  })

  it('answers pending while the wallet has not presented', async () => {
    const a = await app()
    const begun = await request(a, 'GET', AUTHORIZE)
    const poll = await request(a, 'GET', `/authorize/${String(begun.body.requestId)}`)
    expect(poll.body).toMatchObject({ status: 'pending', session: { id: 'sess-1' } })
  })
})
