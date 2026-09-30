/**
 * Trust Lens — the orchestrator surface.
 *
 * A thin backend over the verification engine. Discovery goes through the ARD registry when one
 * is configured (relevance only, never trust); when it is not, the same publishers are crawled
 * directly so the demo runs standalone. Either way, verification re-fetches everything from the
 * publisher, so what the registry says never affects a verdict.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import * as dotenv from 'dotenv'
import express from 'express'

import { AuditLog } from '../core/audit'
import { AiCatalog, AiCatalogEntry, Verdict } from '../core/types'
import { verifyEntry } from '../core/verify'
import { createVerifierAgent, verifierDependencies, VerifierAgent } from '../shared/credential-verifier'
import { ACME_DOMAIN, PRO_DOMAIN, TRUSTCO } from '../shared/demo-config'
import { identityServiceFromEnv } from '../shared/identity-service'
import { WALLET_LINK_FILE, WalletLink } from '../shared/wallet-link'
import { credoWalletTransport } from '../shared/wallet-link-credo'
import { loadState } from '../seed/state'
import { llmConfigFromEnv } from './llm'
import { McpConnection } from './mcp-client'
import { McpPath } from './mcp-path'
import { TrustLensOAuthProvider } from './oauth-provider'
import { TaskTracker } from './tasks'

dotenv.config()

const PORT = Number(process.env.TRUST_LENS_WEB_PORT ?? 4000)
const SITES_PORT = process.env.SITES_PORT ?? '443'
const SITE_SUFFIX = SITES_PORT === '443' ? '' : `:${SITES_PORT}`
const PUBLISHERS = [ACME_DOMAIN, PRO_DOMAIN]
const AGENT_URL = process.env.ACME_AGENT_URL ?? `http://localhost:${process.env.ACME_AGENT_PORT ?? 10003}`
const DEFAULT_TASK_PROMPT = 'Reconcile May supplier invoices and prepare the payment export.'
const MCP_URL = process.env.MCP_PUBLIC_URL ?? `http://localhost:${process.env.MCP_PORT ?? 4400}`
const DIDCOMM_PORT = Number(process.env.TRUST_LENS_DIDCOMM_PORT ?? 4010)

// The publisher sites use a self-signed development certificate.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

interface DiscoveredEntry {
  entry: AiCatalogEntry
  servingDomain: string
  /** Relevance only. ARD 7.2: MUST NOT be read as a trust signal. */
  score: number
  source: string
}

async function fetchCatalog(domain: string): Promise<AiCatalog> {
  const response = await fetch(`https://${domain}${SITE_SUFFIX}/.well-known/ai-catalog.json`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return (await response.json()) as AiCatalog
}

/** Crude relevance scoring, standing in for the registry's semantic search. */
function relevance(entry: AiCatalogEntry, query: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return 50

  const haystack = [entry.displayName, entry.description, ...(entry.tags ?? []), ...(entry.capabilities ?? [])]
    .join(' ')
    .toLowerCase()

  const hits = terms.filter((term) => haystack.includes(term)).length
  // No hit at all is not a weak match, it is no match: the caller drops a zero score. The type
  // bonus only breaks ties among entries that did match.
  if (!hits) return 0
  return Math.round((hits / terms.length) * 90) + (entry.type.includes('a2a') ? 3 : 1)
}

async function discover(query: string): Promise<DiscoveredEntry[]> {
  const discovered: DiscoveredEntry[] = []

  for (const domain of PUBLISHERS) {
    try {
      const catalog = await fetchCatalog(domain)
      for (const entry of catalog.entries) {
        const score = relevance(entry, query)
        if (score > 0) discovered.push({ entry, servingDomain: domain, score, source: domain })
      }
    } catch (error) {
      console.warn(`[web] could not read the catalog at ${domain}: ${(error as Error).message}`)
    }
  }

  return discovered.sort((a, b) => b.score - a.score)
}

function main() {
  const state = loadState()
  if (!state.issuerDid) throw new Error('no seed state — run `yarn seed` first')

  const audit = new AuditLog()
  const tasks = new TaskTracker(AGENT_URL, audit, identityServiceFromEnv())
  const mcp = new McpConnection(new TrustLensOAuthProvider())
  // The operator's phone. Credo is only brought up on first use, so a stand without a wallet
  // pays nothing for this.
  const walletLink = new WalletLink({
    stateFile: WALLET_LINK_FILE,
    initialDid: process.env.HOLDER_PUBLIC_DID,
    transport: () => credoWalletTransport({ label: 'trust-lens-wallet-link', inboundPort: DIDCOMM_PORT }),
  })
  let verifierReady: Promise<VerifierAgent> | undefined

  /**
   * The verifier agent is brought up on first use; a stand that never verifies pays nothing for it.
   * The promise, not the agent, is memoized: a request arriving while the first is still
   * initialising would otherwise find the agent set and verify with one that is not ready yet.
   * A failed start is forgotten so the next request retries instead of failing forever.
   */
  const verifierOptions = async () => {
    if (!verifierReady) {
      const agent = createVerifierAgent()
      verifierReady = agent.initialize().then(
        () => agent,
        (error: unknown) => {
          verifierReady = undefined
          throw error
        }
      )
    }
    const agent = await verifierReady
    return { trustedIssuers: [state.issuerDid as string], ...verifierDependencies(agent) }
  }

  const mcpPath = new McpPath({
    audit,
    mcp,
    tasks,
    walletLink,
    discover: () => discover(''),
    verifierOptions,
    envMcpUrl: MCP_URL,
  })

  const app = express()
  app.use(express.json())
  const publicDir = resolve(process.cwd(), 'src/web/public')
  app.use(express.static(publicDir))

  // Each view has a path so it can be linked, reloaded and reached with the browser's back button.
  // They are all the same single page; the client reads the path and opens the view.
  app.get(['/discovery', '/tasks', '/tasks/:id', '/mcp', '/audit'], (_req, res) => {
    res.sendFile(resolve(publicDir, 'index.html'))
  })

  app.get('/api/config', (_req, res) => {
    res.json({
      trustedIssuers: [state.issuerDid],
      trustedIssuerName: TRUSTCO.name,
      publishers: PUBLISHERS,
      registry: process.env.REGISTRY_URL ?? null,
      wallet: walletLink.status,
    })
  })

  // ---------- operator's wallet ----------

  app.get('/api/wallet', (_req, res) => {
    res.json(walletLink.status)
  })

  /** Link the operator's Heka Wallet by its public DID (the wallet logs it at startup). */
  app.post('/api/wallet/link', async (req, res) => {
    try {
      res.json(await walletLink.link(String(req.body?.holderDid ?? '').trim()))
    } catch (error) {
      res.status(400).json({ error: (error as Error).message })
    }
  })

  app.delete('/api/wallet/link', async (_req, res) => {
    await walletLink.unlink()
    res.json(walletLink.status)
  })

  app.get('/api/discovery', async (req, res) => {
    try {
      const query = String(req.query.q ?? '')
      const results = await discover(query)
      res.json({
        query,
        // Surfaced so the UI can say out loud that ranking is not trust.
        scoreMeaning: 'relevance only — ARD 7.2: MUST NOT be interpreted as a trust rating',
        results: results.map(({ entry, servingDomain, score, source }) => ({
          identifier: entry.identifier,
          displayName: entry.displayName,
          type: entry.type,
          description: entry.description,
          publisher: servingDomain,
          score,
          source,
          hasAttestation: Boolean(entry.trustManifest?.attestations?.length),
        })),
      })
    } catch (error) {
      res.status(500).json({ error: (error as Error).message })
    }
  })

  app.post('/api/verify', async (req, res) => {
    try {
      const identifiers: string[] | undefined = req.body?.identifiers
      const discovered = await discover('')
      const targets = identifiers?.length
        ? discovered.filter((item) => identifiers.includes(item.entry.identifier))
        : discovered

      const options = await verifierOptions()

      const results = []
      for (const { entry, servingDomain } of targets) {
        const result = await verifyEntry(entry, { servingDomain }, options)
        const event = audit.record('verification', entry.displayName, result.verdict, result.evidence)

        results.push({
          identifier: entry.identifier,
          displayName: entry.displayName,
          verdict: result.verdict,
          engageable: result.verdict === Verdict.Verified,
          evidence: result.evidence,
          auditId: event.id,
          verifiedAt: result.verifiedAt,
        })
      }

      res.json({ results })
    } catch (error) {
      res.status(500).json({ error: (error as Error).message })
    }
  })

  /**
   * Engage a resource. Fail closed: the resource is re-verified here and now, and whatever verdict
   * the browser holds is not consulted — a stale or forged VERIFIED must not start a task. The
   * cost is one more Hedera resolution per Engage; the alternative is a gate that trusts the caller.
   */
  app.post('/api/engage', async (req, res) => {
    const identifier = String(req.body?.identifier ?? '')

    try {
      const target = (await discover('')).find((item) => item.entry.identifier === identifier)
      if (!target) {
        res.status(404).json({ error: 'unknown resource' })
        return
      }

      const result = await verifyEntry(target.entry, { servingDomain: target.servingDomain }, await verifierOptions())
      const verification = audit.record('verification', target.entry.displayName, result.verdict, result.evidence)

      if (result.verdict !== Verdict.Verified) {
        const refusal = audit.record('engagement_refused', identifier, result.verdict, {
          reason: 'resource is not VERIFIED at engagement time',
          verdict: result.verdict,
          verificationAuditId: verification.id,
        })
        res.status(403).json({ error: 'refused: not verified', verdict: result.verdict, auditId: refusal.id })
        return
      }

      const preflight = { verdict: result.verdict, auditId: verification.id, verifiedAt: result.verifiedAt }
      if (!target.entry.type.includes('a2a')) {
        // An MCP server is engaged by connecting to what its verified card says and calling its
        // tools; from here on every call re-verifies the entry (the gate in mcp-path.ts).
        const connected = await mcpPath.engage(target.entry, target.servingDomain, result.card)
        res.json({ ok: true, kind: 'mcp', ...preflight, connected })
        return
      }

      const task = await tasks.start(
        target.entry.displayName,
        String(req.body?.prompt ?? DEFAULT_TASK_PROMPT),
        preflight
      )
      res.json({ ok: true, kind: 'agent', taskId: task.id, ...preflight })
    } catch (error) {
      res.status(502).json({ error: `could not engage: ${(error as Error).message}` })
    }
  })

  app.get('/api/task/:id', (req, res) => {
    const task = tasks.get(req.params.id)
    if (!task) {
      res.status(404).json({ error: 'unknown task' })
      return
    }
    res.json(task)
  })

  /** Every engagement this process has seen, newest first — enough for a list; open one for the rest. */
  app.get('/api/tasks', (_req, res) => {
    res.json({
      tasks: tasks.list().map(({ id, resource, state, startedAt, a2a, presentation }) => ({
        id,
        resource,
        state,
        startedAt,
        a2a,
        presentation: presentation && {
          outcome: presentation.outcome,
          claims: presentation.claims,
          source: presentation.source,
        },
      })),
    })
  })

  /** Push the pending OID4VP request to the operator's phone over DIDComm. */
  app.post('/api/task/:id/send-to-wallet', async (req, res) => {
    const task = tasks.get(req.params.id)
    if (!tasks.awaitingPresentation(task)) {
      res.status(409).json({ error: 'this task is not waiting for an authorization' })
      return
    }
    if (!walletLink.status.linked) {
      res.status(409).json({ error: 'no wallet linked — paste the wallet’s Public DID first' })
      return
    }

    const delivery = await tasks.sendToWallet(task, (content) => walletLink.send(content))
    res.status(delivery.state === 'sent' ? 200 : 502).json({ delivery })
  })

  /**
   * Present the officer credential from the in-process holder instead of a phone.
   * Clearly labelled as simulated in the UI and in the audit trail — who presented the
   * credential is precisely what this demo is about.
   */
  app.post('/api/task/:id/simulate-presentation', async (req, res) => {
    const task = tasks.get(req.params.id)
    if (!tasks.awaitingPresentation(task)) {
      res.status(409).json({ error: 'this task is not waiting for an authorization' })
      return
    }

    try {
      await tasks.simulatePresentation(task)
      res.json({ ok: true })
    } catch (error) {
      res.status(500).json({ error: (error as Error).message })
    }
  })

  // ---------- MCP path ----------

  mcpPath.mount(app)
  // The model is optional; without a key the chat says so and the direct calls remain.
  void mcpPath.startChat(llmConfigFromEnv())

  app.get('/api/audit', (req, res) => {
    const type = req.query.type ? String(req.query.type) : undefined
    res.json({ events: audit.list({ type: type as never }) })
  })

  app.listen(PORT, () => {
    console.log(`[web] Trust Lens on http://localhost:${PORT}`)
    console.log(`[web] trusted issuer: ${state.issuerDid}`)
  })
}

try {
  main()
} catch (error) {
  console.error('[web] FATAL', (error as Error)?.message ?? error)
  process.exit(1)
}
