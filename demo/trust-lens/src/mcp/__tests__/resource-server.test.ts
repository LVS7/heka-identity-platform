import { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createResourceServer } from '../resource-server'

const PUBLIC_URL = 'http://mcp.test'
const AS_URL = 'http://as.test'

/** Tokens are opaque strings here: the JWT check is the AS's contract, exercised live, not the guard's. */
const verifyToken = async (jwt: string) => {
  if (jwt === 'scoped') {
    return { scope: 'suppliers:export', role: 'Finance Data Officer', org: 'TrustCo', client_id: 'trust-lens' }
  }
  if (jwt === 'scopeless') return { scope: 'invoices:read', role: 'Clerk', org: 'Acme' }
  throw new Error('signature verification failed')
}

let base = ''
let server: ReturnType<ReturnType<typeof createResourceServer>['listen']>

beforeAll(async () => {
  const app = createResourceServer({ publicUrl: PUBLIC_URL, asUrl: AS_URL, verifyToken, log: () => undefined })
  server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise((resolve) => server.close(resolve)))

async function rpc(body: unknown, token?: string) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, challenge: response.headers.get('www-authenticate'), body: await response.json() }
}

const call = (name: string, id = 2) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })
const rows = (body: { result: { content: Array<{ text: string }> } }) => JSON.parse(body.result.content[0].text)

describe('the MCP resource server', () => {
  it('lists both tools anonymously, each naming its required scope in _meta', async () => {
    const { status, body } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })

    expect(status).toBe(200)
    expect(
      body.result.tools.map((tool: { name: string; _meta?: { requiredScope?: unknown } }) => [
        tool.name,
        tool._meta?.requiredScope,
      ])
    ).toEqual([
      ['invoices-list', null],
      ['suppliers-export-bank-details', 'suppliers:export'],
    ])
  })

  it('answers the routine tool anonymously', async () => {
    const { status, body } = await rpc(call('invoices-list'))

    expect(status).toBe(200)
    expect(rows(body).rows).toHaveLength(4)
    expect(rows(body).authorizedBy).toBeUndefined()
  })

  it('challenges the sensitive tool with 401 naming the scope and the resource metadata', async () => {
    const { status, challenge, body } = await rpc(call('suppliers-export-bank-details'))

    expect(status).toBe(401)
    expect(challenge).toBe(
      `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource", scope="suppliers:export"`
    )
    expect(body.error).toBe('unauthorized')
  })

  it('answers 403 insufficient_scope to a token that lacks the scope', async () => {
    const { status, challenge, body } = await rpc(call('suppliers-export-bank-details'), 'scopeless')

    expect(status).toBe(403)
    expect(challenge).toContain('error="insufficient_scope"')
    expect(challenge).toContain('scope="suppliers:export"')
    expect(body).toEqual({ error: 'insufficient_scope', required_scope: 'suppliers:export' })
  })

  it('returns the rows with authorizedBy on a scoped token', async () => {
    const { status, body } = await rpc(call('suppliers-export-bank-details'), 'scoped')

    expect(status).toBe(200)
    expect(rows(body).rows).toHaveLength(3)
    expect(rows(body).authorizedBy).toEqual({ role: 'Finance Data Officer', org: 'TrustCo' })
  })

  it('rejects a malformed token with 401 invalid_token even for the routine tool', async () => {
    const { status, challenge } = await rpc(call('invoices-list'), 'garbage')

    expect(status).toBe(401)
    expect(challenge).toContain('error="invalid_token"')
  })

  it('guards every request of a batch', async () => {
    const { status } = await rpc([call('invoices-list', 1), call('suppliers-export-bank-details', 2)])

    expect(status).toBe(401)
  })

  it('answers an unknown tool with a JSON-RPC error, never a challenge', async () => {
    const { status, challenge, body } = await rpc(call('delete-everything'))

    expect(status).toBe(200)
    expect(challenge).toBeNull()
    // The SDK reports an unknown tool as an error *result*, which the client surfaces as a tool error.
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toContain('delete-everything')
  })

  it('publishes the protected resource metadata at both well-known paths with the /mcp resource', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const body = await (await fetch(`${base}${path}`)).json()
      expect(body).toEqual({
        resource: `${PUBLIC_URL}/mcp`,
        authorization_servers: [AS_URL],
        scopes_supported: ['suppliers:export'],
        bearer_methods_supported: ['header'],
      })
    }
  })

  it('has no REST routes and no GET/DELETE on the MCP endpoint', async () => {
    expect((await fetch(`${base}/tools`)).status).toBe(404)
    expect((await fetch(`${base}/tools/invoices-list`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(`${base}/mcp`)).status).toBe(405)
    expect((await fetch(`${base}/mcp`, { method: 'DELETE' })).status).toBe(405)
  })
})
