import { createHash } from 'node:crypto'
import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'

import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'

import { createResourceServer } from '../../mcp/resource-server'
import {
  AuthorizationDeniedError,
  AuthorizationLostError,
  AuthorizationUnavailableError,
  McpConnection,
} from '../mcp-client'
import { TrustLensOAuthProvider } from '../oauth-provider'

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

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

async function listen(app: express.Express): Promise<string> {
  const server = createServer(app)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** A port nobody holds, so the resource server can be built with the URL it will actually listen on. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/** An AS with the real metadata shape and scripted poll answers; everything else is what the real one does. */
async function fakeAs(polls: Array<[number, unknown]>) {
  const app = express()
  app.use(express.urlencoded({ extended: true }))
  const authorizeCalls: URL[] = []
  const tokenRequests: Array<Record<string, string>> = []
  let issuer = ''

  app.get('/.well-known/oauth-authorization-server', (_req, res) =>
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    })
  )
  app.get('/authorize', (req, res) => {
    authorizeCalls.push(new URL(req.originalUrl, issuer))
    res.json({
      requestId: `req-${authorizeCalls.length}`,
      authorizationRequest: 'openid4vp://?request_uri=x',
      session: { id: 'sess-1', state: 'RequestCreated' },
      requested: REQUESTED,
      message: 'Present a Finance Data Officer credential',
    })
  })
  app.get('/authorize/:id', (_req, res) => {
    const [status, body] = polls.shift() ?? [200, { status: 'pending' }]
    res.status(status).json(body)
  })
  app.post('/token', (req, res) => {
    tokenRequests.push(req.body)
    res.json({ access_token: 'scoped', token_type: 'Bearer', expires_in: 300, scope: 'suppliers:export' })
  })

  issuer = await listen(app)
  return { issuer, authorizeCalls, tokenRequests }
}

async function stack(polls: Array<[number, unknown]> = []) {
  const as = await fakeAs(polls)
  const port = await freePort()
  const publicUrl = `http://127.0.0.1:${port}`
  const rs = createResourceServer({
    publicUrl,
    asUrl: as.issuer,
    log: () => undefined,
    verifyToken: async (jwt) => {
      if (jwt === 'scoped') return { scope: 'suppliers:export', role: 'Finance Data Officer', org: 'TrustCo' }
      throw new Error('unknown token')
    },
  })
  const server = createServer(rs)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))

  const provider = new TrustLensOAuthProvider()
  const mcp = new McpConnection(provider)
  await mcp.connect(`${publicUrl}/mcp`)
  return { as, mcp, provider, publicUrl }
}

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

describe('McpConnection', () => {
  it('connects, lists the tools with their scopes, and calls the routine tool anonymously', async () => {
    const { mcp, as } = await stack()

    expect(await mcp.listTools()).toMatchObject([
      { name: 'invoices-list', requiredScope: null },
      { name: 'suppliers-export-bank-details', requiredScope: 'suppliers:export' },
    ])
    const outcome = await mcp.callTool('invoices-list')
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.result.rows).toHaveLength(4)
    expect(as.authorizeCalls).toHaveLength(0)
  })

  it('turns a 401 into a pending step-up started through the spec chain, and reuses it while it is pending', async () => {
    const { mcp, as, publicUrl } = await stack()

    const first = await mcp.callTool('suppliers-export-bank-details')
    const second = await mcp.callTool('suppliers-export-bank-details')

    expect(first).toMatchObject({
      ok: false,
      status: 401,
      requiredScope: 'suppliers:export',
      pending: { requestId: 'req-1', session: { id: 'sess-1', state: 'RequestCreated' }, requested: REQUESTED },
    })
    expect(second).toMatchObject({ ok: false, pending: { requestId: 'req-1' } })
    expect(as.authorizeCalls).toHaveLength(1)
    const params = as.authorizeCalls[0].searchParams
    expect(params.get('client_id')).toBe('trust-lens')
    expect(params.get('response_type')).toBe('code')
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('scope')).toBe('suppliers:export')
    expect(params.get('resource')).toBe(`${publicUrl}/mcp`)
    expect(params.get('redirect_uri')).toBe('http://localhost:4000/oauth/callback')
  })

  it('reports the session state while pending', async () => {
    const { mcp } = await stack([[200, { status: 'pending', session: { id: 'sess-1', state: 'RequestUriRetrieved' } }]])
    await mcp.callTool('suppliers-export-bank-details')

    expect(await mcp.pollAuthorization()).toEqual({
      granted: false,
      session: { id: 'sess-1', state: 'RequestUriRetrieved' },
    })
    expect(mcp.pending?.session).toEqual({ id: 'sess-1', state: 'RequestUriRetrieved' })
  })

  it('exchanges the code with the saved verifier on granted, then the retried call succeeds with the token', async () => {
    const { mcp, as } = await stack([
      [200, { status: 'granted', code: 'c1', redirectTo: 'x', presentation: PRESENTATION }],
    ])
    const refused = await mcp.callTool('suppliers-export-bank-details')
    if (refused.ok || refused.status === 'error') throw new Error('expected a step-up')
    refused.pending.source = 'simulated'

    const poll = await mcp.pollAuthorization()

    expect(poll.granted).toBe(true)
    expect(poll.presentation).toEqual({ ...PRESENTATION, source: 'simulated' })
    expect(mcp.pending).toBeUndefined()
    expect(mcp.tokenStatus.present).toBe(true)
    expect(mcp.lastDecision).toMatchObject({ granted: true })
    const token = as.tokenRequests[0]
    expect(token.grant_type).toBe('authorization_code')
    expect(token.code).toBe('c1')
    expect(token.redirect_uri).toBe('http://localhost:4000/oauth/callback')
    expect(s256(token.code_verifier)).toBe(as.authorizeCalls[0].searchParams.get('code_challenge'))

    const retried = await mcp.callTool('suppliers-export-bank-details')
    expect(retried).toMatchObject({
      ok: true,
      result: { authorizedBy: { role: 'Finance Data Officer', org: 'TrustCo' } },
    })
    if (retried.ok) expect(retried.result.rows).toHaveLength(3)
  })

  it('infers a scan when granted with nothing pressed', async () => {
    const { mcp } = await stack([[200, { status: 'granted', code: 'c1', redirectTo: 'x', presentation: PRESENTATION }]])
    await mcp.callTool('suppliers-export-bank-details')

    expect((await mcp.pollAuthorization()).presentation?.source).toBe('qr')
  })

  it('throws a denial carrying the refused presentation, forgets the pending entry and remembers the decision', async () => {
    const denied = { sessionId: 'sess-1', outcome: 'denied' as const, reason: 'revoked', vpToken: 'ey' }
    const { mcp } = await stack([[403, { error: 'access_denied', error_description: 'revoked', presentation: denied }]])
    await mcp.callTool('suppliers-export-bank-details')

    const error = await mcp.pollAuthorization().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AuthorizationDeniedError)
    expect((error as AuthorizationDeniedError).message).toBe('revoked')
    expect((error as AuthorizationDeniedError).presentation).toEqual({ ...denied, source: 'qr' })
    expect(mcp.pending).toBeUndefined()
    expect(mcp.lastDecision).toMatchObject({ granted: false, reason: 'revoked' })
    expect(mcp.tokenStatus.present).toBe(false)
  })

  it('answers an unknown tool with an error and never starts a step-up', async () => {
    const { mcp, as } = await stack()

    const outcome = await mcp.callTool('delete-everything')

    expect(outcome).toMatchObject({ ok: false, status: 'error' })
    expect(as.authorizeCalls).toHaveLength(0)
    expect(mcp.pending).toBeUndefined()
  })

  it('needs a new grant after the token is dropped', async () => {
    const { mcp, as } = await stack([
      [200, { status: 'granted', code: 'c1', redirectTo: 'x', presentation: PRESENTATION }],
    ])
    await mcp.callTool('suppliers-export-bank-details')
    await mcp.pollAuthorization()

    mcp.forgetToken()

    expect(mcp.tokenStatus.present).toBe(false)
    expect(await mcp.callTool('suppliers-export-bank-details')).toMatchObject({
      ok: false,
      status: 401,
      pending: { requestId: 'req-2' },
    })
    expect(as.authorizeCalls).toHaveLength(2)
  })

  it('keeps the step-up pending when the AS is unavailable', async () => {
    const { mcp } = await stack([[503, { error: 'temporarily_unavailable', error_description: 'heka down' }]])
    await mcp.callTool('suppliers-export-bank-details')

    await expect(mcp.pollAuthorization()).rejects.toBeInstanceOf(AuthorizationUnavailableError)
    expect(mcp.pending).toBeDefined()
    expect(mcp.lastDecision).toBeUndefined()
    expect(await mcp.pollAuthorization()).toMatchObject({ granted: false })
  })

  it('ends the step-up without a denial when the AS no longer knows the request', async () => {
    const { mcp } = await stack([
      [404, { error: 'invalid_request', error_description: 'unknown authorization request' }],
    ])
    await mcp.callTool('suppliers-export-bank-details')

    await expect(mcp.pollAuthorization()).rejects.toBeInstanceOf(AuthorizationLostError)
    expect(mcp.pending).toBeUndefined()
    expect(mcp.lastDecision).toMatchObject({
      granted: false,
      incomplete: true,
      reason: 'unknown authorization request',
    })
  })

  it('labels a refused presentation without a vp_token as unknown, not as a scan', async () => {
    const denied = { sessionId: 'sess-1', outcome: 'denied' as const, reason: 'no trusted issuer' }
    const { mcp } = await stack([
      [403, { error: 'access_denied', error_description: 'no trusted issuer', presentation: denied }],
    ])
    await mcp.callTool('suppliers-export-bank-details')

    const error = await mcp.pollAuthorization().catch((e: unknown) => e)
    expect((error as AuthorizationDeniedError).presentation?.source).toBe('unknown')
  })

  it('refuses to poll when nothing is pending', async () => {
    const { mcp } = await stack()
    await expect(mcp.pollAuthorization()).rejects.toThrow('no authorization is in progress')
  })
})
