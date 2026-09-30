import { describe, expect, it, vi } from 'vitest'

import { AuthorizationDeniedError, McpClient } from '../mcp-client'

const MCP = 'http://mcp.test'
const AS = 'http://as.test'
const REQUESTED = {
  purpose: 'Authorize export',
  credentialType: 'urn:heka:role-credential:v1',
  claims: ['role', 'org'],
}
const PRESENTATION = {
  sessionId: 'sess-1',
  outcome: 'authorized' as const,
  claims: { role: 'Finance Data Officer', org: 'TrustCo' },
  vpToken: 'ey',
}

const reply = (status: number, body: unknown) => ({
  ok: status < 400,
  status,
  headers: new Headers(),
  json: async () => body,
})

/** An AS whose poll answers are scripted; everything else is the fixed discovery chain. */
function fakeFetch(polls: Array<[number, unknown]>) {
  const authorizeCalls: string[] = []
  const fetchFn = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url === `${MCP}/.well-known/oauth-protected-resource`) {
      return reply(200, { resource: MCP, authorization_servers: [AS] })
    }
    if (url === `${AS}/.well-known/oauth-authorization-server`) {
      return reply(200, { authorization_endpoint: `${AS}/authorize`, token_endpoint: `${AS}/token` })
    }
    if (url.startsWith(`${AS}/authorize?`)) {
      authorizeCalls.push(url)
      return reply(200, {
        requestId: `req-${authorizeCalls.length}`,
        authorizationRequest: 'openid4vp://?request_uri=x',
        session: { id: 'sess-1', state: 'RequestCreated' },
        requested: REQUESTED,
      })
    }
    if (url.startsWith(`${AS}/authorize/`)) {
      const [status, body] = polls.shift() ?? [200, { status: 'pending' }]
      return reply(status, body)
    }
    if (url === `${AS}/token`) return reply(200, { access_token: 'tok', expires_in: 300 })
    throw new Error(`unexpected fetch ${url}`)
  })
  return { fetchFn: fetchFn as unknown as typeof fetch, authorizeCalls }
}

const refused = { status: 401, ok: false, body: {}, requiredScope: 'suppliers:export' }

describe('McpClient step-up', () => {
  it('starts one authorization and reuses it while it is pending for the same scope and resource', async () => {
    const { fetchFn, authorizeCalls } = fakeFetch([])
    const client = new McpClient(MCP, fetchFn)

    const first = await client.beginAuthorization(refused)
    const second = await client.beginAuthorization(refused)

    expect(authorizeCalls).toHaveLength(1)
    expect(second).toBe(first)
    expect(client.pending).toMatchObject({
      requestId: 'req-1',
      session: { id: 'sess-1', state: 'RequestCreated' },
      requested: REQUESTED,
      scope: 'suppliers:export',
    })
  })

  it('reports the session state while pending', async () => {
    const { fetchFn } = fakeFetch([
      [200, { status: 'pending', session: { id: 'sess-1', state: 'RequestUriRetrieved' } }],
    ])
    const client = new McpClient(MCP, fetchFn)
    await client.beginAuthorization(refused)

    const poll = await client.completeAuthorization()

    expect(poll).toEqual({ granted: false, session: { id: 'sess-1', state: 'RequestUriRetrieved' } })
    expect(client.pending?.session).toEqual({ id: 'sess-1', state: 'RequestUriRetrieved' })
  })

  it('exchanges the code on granted, returns the presentation with the source, and forgets the pending entry', async () => {
    const { fetchFn } = fakeFetch([
      [200, { status: 'granted', code: 'c1', redirectTo: 'x', presentation: PRESENTATION }],
    ])
    const client = new McpClient(MCP, fetchFn)
    const pending = await client.beginAuthorization(refused)
    pending.source = 'simulated'

    const poll = await client.completeAuthorization()

    expect(poll.granted).toBe(true)
    expect(poll.presentation).toEqual({ ...PRESENTATION, source: 'simulated' })
    expect(client.tokenStatus.present).toBe(true)
    expect(client.pending).toBeUndefined()
  })

  it('infers a scan when granted with nothing pressed', async () => {
    const { fetchFn } = fakeFetch([
      [200, { status: 'granted', code: 'c1', redirectTo: 'x', presentation: PRESENTATION }],
    ])
    const client = new McpClient(MCP, fetchFn)
    await client.beginAuthorization(refused)

    expect((await client.completeAuthorization()).presentation?.source).toBe('qr')
  })

  it('throws a denial carrying the refused presentation and forgets the pending entry', async () => {
    const denied = { sessionId: 'sess-1', outcome: 'denied' as const, reason: 'revoked', vpToken: 'ey' }
    const { fetchFn } = fakeFetch([
      [403, { error: 'access_denied', error_description: 'revoked', presentation: denied }],
    ])
    const client = new McpClient(MCP, fetchFn)
    await client.beginAuthorization(refused)

    const error = await client.completeAuthorization().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AuthorizationDeniedError)
    expect((error as AuthorizationDeniedError).message).toBe('revoked')
    expect((error as AuthorizationDeniedError).presentation).toEqual({ ...denied, source: 'qr' })
    expect(client.pending).toBeUndefined()
  })

  it('refuses to poll when nothing is pending', async () => {
    const client = new McpClient(MCP, fakeFetch([]).fetchFn)
    await expect(client.completeAuthorization()).rejects.toThrow('no authorization is in progress')
  })
})
