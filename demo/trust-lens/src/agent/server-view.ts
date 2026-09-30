/**
 * The agent's server view: a read-only JSON API and a static page on the A2A port.
 *
 * Mounted on the same `express()` as the protocol, and before it, so `GET /` is the page while
 * `POST /` stays JSON-RPC — `express.static` answers GET and HEAD only and hands anything else on.
 * One action exists, Forget authorizations, for the revocation demo on a reused context; the
 * holder's and the client's actions stay in the Trust Lens.
 */

import { resolve } from 'node:path'

import { AgentCard } from '@a2a-js/sdk'
import express, { Express } from 'express'

import { AgentState } from './state'

export interface AgentIdentity {
  name: string
  publicUrl: string
  port: number
  /** The did:key Heka gave `prepare-wallet`; null until `initialize` has run. */
  verifierDid: string | null
  /** The did:hedera the Resource Passport attests — the seed's, not something the agent proves. */
  resourceDid?: string
  authorizationTimeoutMs: number
  llm: { enabled: boolean; model?: string }
}

export interface TrustSettings {
  trustedIssuer?: string
  statusListOrigin: string
}

export interface ServerViewOptions {
  state: AgentState
  startedAt: string
  /** Functions, not values: the verifier DID and the seed state are known only after boot and can change. */
  identity: () => AgentIdentity
  trust: () => TrustSettings
  card: () => AgentCard
  staticCardUrl: string
  forgetAuthorizations: () => number
}

export function mountServerView(app: Express, options: ServerViewOptions): Express {
  const { state } = options

  app.use(express.static(resolve(process.cwd(), 'src/agent/public')))
  // The page reuses the Trust Lens stylesheet and helpers; a relative link cannot escape a static root.
  app.use('/shared', express.static(resolve(process.cwd(), 'src/web/public')))

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      uptimeSeconds: Math.round((Date.now() - Date.parse(options.startedAt)) / 1000),
      verifierDid: options.identity().verifierDid,
      channel: state.channel,
    })
  })

  app.get('/api/state', (_req, res) => {
    res.json({
      agent: options.identity(),
      trust: options.trust(),
      channel: state.channel,
      counts: state.counts(),
      startedAt: options.startedAt,
    })
  })

  app.get('/api/card', (_req, res) => {
    res.json({
      live: options.card(),
      staticCardUrl: options.staticCardUrl,
      note: 'The digest-pinned card is served by the publisher site and is what the Trust Lens verifies; this live one is what A2A clients connect to.',
    })
  })

  app.get('/api/tasks', (_req, res) => {
    res.json({ tasks: state.listTasks() })
  })

  app.get('/api/tasks/:id', (req, res) => {
    const task = state.tasks.get(String(req.params.id))
    if (!task) {
      res.status(404).json({ error: 'no such task' })
      return
    }
    res.json(task)
  })

  app.get('/api/authorizations', (_req, res) => {
    res.json({ authorizations: state.listAuthorizations() })
  })

  app.get('/api/events', (req, res) => {
    const since = req.query.since ? String(req.query.since) : undefined
    const limit = Number(req.query.limit) || undefined
    res.json({ events: state.journal.list({ since, limit }) })
  })

  app.post('/api/authorizations/forget', (_req, res) => {
    res.json({ cleared: options.forgetAuthorizations() })
  })

  return app
}
