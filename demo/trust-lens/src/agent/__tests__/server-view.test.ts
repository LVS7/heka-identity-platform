import { AddressInfo } from 'node:net'

import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { mountServerView } from '../server-view'
import { AgentState } from '../state'

const CARD = { name: 'Acme Invoice Agent', url: 'http://localhost:10003/' } as never

let base = ''
let close: () => void
const state = new AgentState()
let forgotten = 0

beforeAll(async () => {
  const app = express()
  mountServerView(app, {
    state,
    startedAt: new Date(Date.now() - 5_000).toISOString(),
    identity: () => ({
      name: 'Acme Invoice Agent',
      publicUrl: 'http://localhost:10003/',
      port: 10003,
      verifierDid: 'did:key:z6MkVerifier',
      resourceDid: 'did:hedera:testnet:acme-agent',
      authorizationTimeoutMs: 180_000,
      llm: { enabled: false },
    }),
    trust: () => ({ trustedIssuer: 'did:hedera:testnet:trustco', statusListOrigin: 'http://localhost:3000' }),
    card: () => CARD,
    staticCardUrl: 'https://acme-invoices.example/.well-known/agent-card.json',
    forgetAuthorizations: () => ++forgotten,
  })
  // Stands in for the A2A router: mounted after the view, it must still receive POST /.
  app.post('/', (_req, res) => res.json({ protocol: true }))

  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () => server.close()
})

afterAll(() => close())

const get = async (path: string) => {
  const response = await fetch(`${base}${path}`)
  return { status: response.status, body: await response.json() }
}

describe('server view API', () => {
  it('answers /health with the channel and the verifier identity', async () => {
    const { status, body } = await get('/health')
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, verifierDid: 'did:key:z6MkVerifier', channel: { state: 'connecting' } })
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(5)
  })

  it('describes the agent, its trust settings and the counts', async () => {
    const { body } = await get('/api/state')
    expect(body.agent).toMatchObject({
      name: 'Acme Invoice Agent',
      port: 10003,
      resourceDid: 'did:hedera:testnet:acme-agent',
      authorizationTimeoutMs: 180_000,
      llm: { enabled: false },
    })
    expect(body.trust).toEqual({
      trustedIssuer: 'did:hedera:testnet:trustco',
      statusListOrigin: 'http://localhost:3000',
    })
    expect(body.counts).toEqual({ tasks: 0, authorized: 0, denied: 0, contexts: 0 })
    expect(body.channel.state).toBe('connecting')
    expect(Date.parse(body.startedAt)).not.toBeNaN()
  })

  it('serves the live card next to the static card URL', async () => {
    const { body } = await get('/api/card')
    expect(body.live).toEqual(CARD)
    expect(body.staticCardUrl).toBe('https://acme-invoices.example/.well-known/agent-card.json')
    expect(body.note).toMatch(/digest/)
  })

  it('lists tasks newest first and 404s an unknown one', async () => {
    state.taskStep('t1', 'c1', 'submitted')
    state.taskStep('t2', 'c2', 'submitted')
    const { body } = await get('/api/tasks')
    expect(body.tasks.map((task: { id: string }) => task.id)).toEqual(['t2', 't1'])
    expect((await get('/api/tasks/t1')).body).toMatchObject({ id: 't1', contextId: 'c1' })
    expect((await get('/api/tasks/nope')).status).toBe(404)
  })

  it('lists authorizations and pages events with since and limit', async () => {
    state.authorizationRequested({
      sessionId: 's1',
      taskId: 't1',
      contextId: 'c1',
      expiresAt: '2026-09-28T10:03:00.000Z',
    })
    expect((await get('/api/authorizations')).body.authorizations[0]).toMatchObject({ sessionId: 's1', taskId: 't1' })

    const all = (await get('/api/events')).body.events
    expect(all[0].type).toBe('auth.requested')
    const older = all[1].id
    const since = (await get(`/api/events?since=${older}&limit=5`)).body.events
    expect(since.map((event: { id: string }) => event.id)).toEqual([all[0].id])
    expect((await get('/api/events?limit=2')).body.events).toHaveLength(2)
  })

  it('forgets authorizations through the one action it has', async () => {
    const response = await fetch(`${base}/api/authorizations/forget`, { method: 'POST' })
    expect(await response.json()).toEqual({ cleared: 1 })
    expect(forgotten).toBe(1)
  })

  it('leaves POST / to the protocol and serves the page on GET /', async () => {
    const post = await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(await post.json()).toEqual({ protocol: true })
    const page = await fetch(`${base}/`)
    expect(page.headers.get('content-type')).toMatch(/text\/html/)
    expect(await page.text()).toContain('Acme Invoice Agent')
    const css = await fetch(`${base}/shared/app.css`)
    expect(css.status).toBe(200)
  })
})
