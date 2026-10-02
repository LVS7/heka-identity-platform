/**
 * Trust Lens — the orchestrator surface.
 *
 * A thin backend over the verification engine. Discovery crawls the publishers' catalogs directly
 * (registry ingestion is blocked upstream, spec/ADR-002), returning the shape a registry would:
 * relevance only, never trust. Verification re-fetches everything from the publisher regardless,
 * so a registry could never affect a verdict.
 */

import { resolve } from 'node:path'

import * as dotenv from 'dotenv'
import { AgentCard } from '@a2a-js/sdk'
import express from 'express'

import { AuditLog } from '../core/audit'
import { AiCatalog, AiCatalogEntry, Verdict } from '../core/types'
import { verifyEntry } from '../core/verify'
import { createVerifierAgent, verifierDependencies, VerifierAgent } from '../shared/credential-verifier'
import { ACME_DOMAIN, PRO_DOMAIN, TRUSTCO } from '../shared/demo-config'
import { identityServiceFromEnv } from '../shared/identity-service'
import { listenOrExit } from '../shared/listen'
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

// The publisher sites use a self-signed development certificate.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

/** Every outbound fetch on the demo path is bounded: a hung (not refused) publisher must not freeze a click. */
const FETCH_TIMEOUT_MS = 5_000
const timedFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS) })

interface DiscoveredEntry {
  entry: AiCatalogEntry
  servingDomain: string
  /** Relevance only. ARD 7.2: MUST NOT be read as a trust signal. */
  score: number
  source: string
}

interface Discovery {
  results: DiscoveredEntry[]
  /** Publishers whose catalog could not be read — named, so a refusal can say why. */
  unreachable: string[]
}

interface Target {
  identifier: string
  publisher?: string
}

/** The verify request's targets, from untyped JSON: anything else is ignored rather than trusted. */
function verifyTargets(body: unknown): Target[] {
  const { targets, identifiers } = (body ?? {}) as { targets?: unknown; identifiers?: unknown }
  if (Array.isArray(targets)) {
    return targets
      .filter((t): t is { identifier: unknown; publisher?: unknown } => typeof t === 'object' && t !== null)
      .map((t) => ({
        identifier: String(t.identifier ?? ''),
        publisher: t.publisher ? String(t.publisher) : undefined,
      }))
  }
  if (Array.isArray(identifiers)) return identifiers.map((identifier) => ({ identifier: String(identifier) }))
  return []
}

interface VerifyResult {
  identifier: string
  publisher: string
  displayName: string
  verdict: string
  engageable: boolean
  evidence: unknown
  auditId: string
  verifiedAt?: string
}

async function fetchCatalog(domain: string): Promise<AiCatalog> {
  const response = await timedFetch(`https://${domain}${SITE_SUFFIX}/.well-known/ai-catalog.json`)
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

/** The publishers' catalogs as served now. A publisher that cannot be read is named, not dropped. */
async function discover(query: string, domains: string[] = PUBLISHERS): Promise<Discovery> {
  const results: DiscoveredEntry[] = []
  const unreachable: string[] = []

  await Promise.all(
    domains.map(async (domain) => {
      try {
        for (const entry of (await fetchCatalog(domain)).entries) {
          const score = relevance(entry, query)
          if (score > 0) results.push({ entry, servingDomain: domain, score, source: domain })
        }
      } catch (error) {
        unreachable.push(domain)
        console.warn(`[web] could not read the catalog at ${domain}: ${(error as Error).message}`)
      }
    })
  )

  // Read in parallel; ties keep the publishers' order, not whichever catalog answered first.
  results.sort((a, b) => b.score - a.score || PUBLISHERS.indexOf(a.source) - PUBLISHERS.indexOf(b.source))
  return { results, unreachable }
}

function main() {
  const state = loadState()
  if (!state.issuerDid) throw new Error('no seed state — run `yarn seed` first')

  const audit = new AuditLog()
  const tasks = new TaskTracker(audit, identityServiceFromEnv(), { agentUrl: AGENT_URL })
  const mcp = new McpConnection(new TrustLensOAuthProvider())
  // The operator's phone. Credo is only brought up on first use, so a stand without a wallet
  // pays nothing for this.
  const walletLink = new WalletLink({
    stateFile: WALLET_LINK_FILE,
    initialDid: process.env.HOLDER_PUBLIC_DID,
    transport: () => credoWalletTransport({ label: 'trust-lens-wallet-link' }),
  })
  let verifierReady: Promise<VerifierAgent> | undefined

  /** Read per use: `yarn seed --reset` mints a new issuer, and a cached one would refuse everything. */
  const trustedIssuer = (): string => {
    const issuerDid = loadState().issuerDid
    if (!issuerDid) throw new Error('no seed state — run `yarn seed` first')
    return issuerDid
  }

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
    return { trustedIssuers: [trustedIssuer()], ...verifierDependencies(agent), fetchFn: timedFetch }
  }

  const mcpPath = new McpPath({
    audit,
    mcp,
    tasks,
    walletLink,
    discover: (domain) => discover('', [domain]),
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
      trustedIssuers: [loadState().issuerDid],
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
    try {
      await walletLink.unlink()
      res.json(walletLink.status)
    } catch (error) {
      // The link file could not be removed (EBUSY on Windows, say): say so rather than claim "not linked".
      res.status(500).json({ error: (error as Error).message })
    }
  })

  app.get('/api/discovery', async (req, res) => {
    try {
      const query = String(req.query.q ?? '')
      const { results, unreachable } = await discover(query)
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
        unreachable,
      })
    } catch (error) {
      res.status(500).json({ error: (error as Error).message })
    }
  })

  /**
   * Verify what is asked for — `targets` ({identifier, publisher}), or the older `identifiers` — or
   * everything published. An identifier is the publisher's own claim, so a target names both.
   */
  app.post('/api/verify', async (req, res) => {
    try {
      const wanted = verifyTargets(req.body).filter((t) => !t.publisher || PUBLISHERS.includes(t.publisher))
      const { results: discovered, unreachable } = await discover('')
      const matches = (item: DiscoveredEntry, target: Target) =>
        item.entry.identifier === target.identifier && (!target.publisher || item.servingDomain === target.publisher)
      const targets = wanted.length ? discovered.filter((item) => wanted.some((t) => matches(item, t))) : discovered

      const options = await verifierOptions()
      // One after another, not in parallel: the entries share an issuer, and concurrent first
      // resolutions of one DID collide in Credo's persisted DID cache ("Duplicate entry").
      const results: VerifyResult[] = []
      for (const { entry, servingDomain } of targets) {
        const result = await verifyEntry(entry, { servingDomain }, options)
        const event = audit.record('verification', entry.displayName, result.verdict, result.evidence)
        results.push({
          identifier: entry.identifier,
          publisher: servingDomain,
          displayName: entry.displayName,
          verdict: result.verdict,
          engageable: result.verdict === Verdict.Verified,
          evidence: result.evidence,
          auditId: event.id,
          verifiedAt: result.verifiedAt,
        })
      }

      // Asked for, but its publisher could not be read: not VERIFIED, and that is a recorded refusal
      // rather than an entry that silently drops out of the answer.
      for (const target of wanted) {
        if (targets.some((item) => matches(item, target))) continue
        if (!target.publisher || !unreachable.includes(target.publisher)) continue
        const failureDetail = `the catalog at ${target.publisher} could not be read`
        const event = audit.record('verification', target.identifier, 'UNAVAILABLE', { failureDetail })
        results.push({
          identifier: target.identifier,
          publisher: target.publisher,
          displayName: target.identifier,
          verdict: 'UNAVAILABLE',
          engageable: false,
          evidence: { failureDetail },
          auditId: event.id,
        })
      }

      res.json({ results, unreachable })
    } catch (error) {
      res.status(500).json({ error: (error as Error).message })
    }
  })

  /**
   * Engage a resource. Fail closed: the resource is re-verified here and now, and whatever verdict
   * the browser holds is not consulted — a stale or forged VERIFIED must not start a task. The
   * cost is a fresh fetch of the catalog, attestation, card and status list; the alternative is a
   * gate that trusts the caller.
   */
  app.post('/api/engage', async (req, res) => {
    const identifier = String(req.body?.identifier ?? '')
    const publisher = req.body?.publisher ? String(req.body.publisher) : undefined
    // Only the configured publishers are fetched: the body must not point the server at any host.
    if (publisher && !PUBLISHERS.includes(publisher)) {
      res.status(400).json({ error: `unknown publisher "${publisher}"` })
      return
    }

    try {
      const { results, unreachable } = await discover('', publisher ? [publisher] : PUBLISHERS)
      const target = results.find(
        (item) => item.entry.identifier === identifier && (!publisher || item.servingDomain === publisher)
      )
      if (!target) {
        if (unreachable.length) {
          // Cannot re-verify, so cannot engage — and that refusal is a trust decision like any other.
          const reason = `the catalog at ${unreachable.join(', ')} could not be read`
          const refusal = audit.record('engagement_refused', identifier, 'UNAVAILABLE', { reason })
          res.status(503).json({ error: `refused: ${reason}`, verdict: 'UNAVAILABLE', auditId: refusal.id })
          return
        }
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
        {
          identifier,
          publisher: target.servingDomain,
          resource: target.entry.displayName,
          card: result.card as AgentCard | undefined,
        },
        String(req.body?.prompt ?? DEFAULT_TASK_PROMPT),
        preflight,
        req.body?.contextId ? String(req.body.contextId) : undefined
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
      tasks: tasks.list().map(({ id, identifier, publisher, resource, state, startedAt, a2a, presentation }) => ({
        id,
        identifier,
        publisher,
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

  listenOrExit(app, PORT, 'web', () => {
    console.log(`[web] Trust Lens on http://localhost:${PORT}`)
    console.log(`[web] trusted issuer: ${state.issuerDid}`)
  })

  // Start the verifier now rather than on the first Verify all, which is the first click an audience sees.
  verifierOptions().catch((error: unknown) =>
    console.warn(`[web] verifier not ready yet: ${(error as Error).message}; the first verification retries`)
  )
}

try {
  main()
} catch (error) {
  console.error('[web] FATAL', (error as Error)?.message ?? error)
  process.exit(1)
}
