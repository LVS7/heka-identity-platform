/**
 * Entry point of the Acme Invoice Agent — an A2A server whose sensitive step requires a verifiable
 * authorization from a human, over the published OID4VP In-Task Auth extension. The executor is in
 * ./executor.ts; this file reads the environment, mounts the server view and the A2A routes, and
 * listens.
 */

import express from 'express'

import { DefaultRequestHandler, InMemoryTaskStore, TaskStore } from '@a2a-js/sdk/server'
import { A2AExpressApp } from '@a2a-js/sdk/server/express'
import * as dotenv from 'dotenv'

import { loadState } from '../seed/state'
import { ACME_DOMAIN } from '../shared/demo-config'
import { identityServiceFromEnv } from '../shared/identity-service'
import { listenOrExit } from '../shared/listen'
import { agentCard, InvoiceAgentExecutor } from './executor'
import { llmEnabled, LLM_MODEL } from './invoice-work'
import { mountServerView } from './server-view'
import { AgentState } from './state'

dotenv.config()

const PORT = Number(process.env.ACME_AGENT_PORT ?? 10003)
/**
 * Advertised in the agent card, which is what A2A clients actually connect to — so it must be
 * reachable from the client, not just from here (they are different hosts under Docker).
 */
const PUBLIC_URL = process.env.ACME_AGENT_PUBLIC_URL ?? `http://localhost:${PORT}/`
/** Long enough for a human to pick up a phone, scan and consent. */
const AUTHORIZATION_TIMEOUT_MS = Number(process.env.AGENT_AUTH_TIMEOUT_MS ?? 180_000)

async function main() {
  const startedAt = new Date().toISOString()
  const identityService = identityServiceFromEnv()
  const state = new AgentState()

  const executor = new InvoiceAgentExecutor(identityService, state, {
    authorizationTimeoutMs: AUTHORIZATION_TIMEOUT_MS,
  })
  await executor.initialize()

  const card = () => agentCard(PUBLIC_URL)
  const handler = new DefaultRequestHandler(card(), new InMemoryTaskStore() as TaskStore, executor)
  const app = express()
  // The server view first: `GET /` is the page, `POST /` (the A2A router, below) stays the protocol.
  mountServerView(app, {
    state,
    startedAt,
    identity: () => ({
      name: 'Acme Invoice Agent',
      publicUrl: PUBLIC_URL,
      port: PORT,
      verifierDid: executor.verifierDid,
      resourceDid: loadState().dids.acmeAgent,
      authorizationTimeoutMs: AUTHORIZATION_TIMEOUT_MS,
      llm: llmEnabled() ? { enabled: true, model: LLM_MODEL } : { enabled: false },
    }),
    trust: () => ({ trustedIssuer: loadState().issuerDid, statusListOrigin: identityService.baseOrigin }),
    card,
    staticCardUrl: `https://${ACME_DOMAIN}/.well-known/agent-card.json`,
    forgetAuthorizations: () => executor.forgetAuthorizations(),
  })
  new A2AExpressApp(handler).setupRoutes(app)

  listenOrExit(app, PORT, 'agent', () => {
    console.log(`[agent] Acme Invoice Agent on http://localhost:${PORT}`)
    console.log(`[agent] agent card: http://localhost:${PORT}/.well-known/agent-card.json`)
    console.log(`[agent] server view: http://localhost:${PORT}/`)
  })
}

main().catch((error) => {
  console.error('[agent] FATAL', error?.response?.data ?? error?.message ?? error)
  process.exit(1)
})
