/**
 * The MCP path of the Trust Lens: the engagement, the per-call gate and every /api/mcp/* route.
 *
 * Engaging the MCP entry connects to the transport URL of the *verified* card. From then on every
 * call is gated: the engaged entry is re-verified with the same engine as /api/engage and the call
 * is refused unless the fresh verdict is VERIFIED — so revoking the server's passport stops MCP
 * calls on the next call, not only on the next Engage (G2 of the revocation audit). Without an
 * engagement in this process the routes refuse too. The env fallback for the URL only chooses a
 * URL; it never bypasses the gate.
 */

import express from 'express'

import { AuditLog } from '../core/audit'
import { AiCatalogEntry, Verdict, VerificationResult } from '../core/types'
import { VerifierOptions, verifyEntry } from '../core/verify'
import { WalletLink } from '../shared/wallet-link'
import { ChatSession } from './chat'
import { createLlm, LLM_NOT_CONFIGURED, LlmConfig } from './llm'
import { AuthorizationDeniedError, AuthorizationUnavailableError, McpConnection } from './mcp-client'
import { PendingAuthorization } from './oauth-provider'
import { AuthorizationView, toAuthorizationState } from './presentation'
import { TaskTracker } from './tasks'
import { deliverToWallet } from './wallet-delivery'

export type GateVia = 'direct call' | 'LLM chat'

export type GateResult =
  | { ok: true; verdict: 'VERIFIED'; verifiedAt: string }
  | { ok: false; verdict: string; auditId: string; reason: string }

export interface Connected {
  url: string
  source: 'verified card' | 'env fallback'
}

export interface McpPathDeps {
  audit: AuditLog
  mcp: McpConnection
  tasks: TaskTracker
  walletLink: WalletLink
  /** One publisher's catalog entries as served right now, with the domain each came from. */
  discover(domain: string): Promise<{ results: Array<{ entry: AiCatalogEntry; servingDomain: string }> }>
  verifierOptions(): Promise<VerifierOptions>
  /** `${MCP_PUBLIC_URL}` — the fallback when a verified card carries no transport URL. */
  envMcpUrl: string
}

/**
 * The step-up as the UI sees it: the same AuthorizationView an A2A task carries (./presentation.ts),
 * so the browser renders both paths from one shape, plus what the AS said and the scope it is for.
 */
export function authorizationView(
  pending: PendingAuthorization
): AuthorizationView & { message?: string; scope: string } {
  return {
    request: pending.authorizationRequest,
    sessionId: pending.session?.id,
    state: toAuthorizationState(pending.session?.state ?? 'RequestCreated'),
    requested: pending.requested,
    delivery: pending.delivery,
    source: pending.source,
    message: pending.message,
    scope: pending.scope,
  }
}

export const NOT_ENGAGED = 'no MCP engagement in this process — verify and engage Acme Invoice Data on Discovery first'

export class McpPath {
  public engagement?: { identifier: string; displayName: string; servingDomain: string }
  public connected?: Connected
  private chat?: ChatSession
  private chatUnavailable: string = LLM_NOT_CONFIGURED

  /** Bring the model up when a key is configured; the chat reports why it is not, otherwise. */
  public async startChat(config: LlmConfig | undefined): Promise<void> {
    if (!config) return
    // Genkit loads for a few seconds; until then the chat must not claim the key is missing.
    this.chatUnavailable = 'starting the model…'
    try {
      const llm = await createLlm(config)
      this.chat = new ChatSession(
        llm,
        this.deps.mcp,
        async (tool) => {
          const gate = await this.gate({ tool, via: 'LLM chat' })
          return gate.ok ? { ok: true } : { ok: false, verdict: gate.verdict }
        },
        this.deps.audit,
        config.model
      )
      this.chatUnavailable = ''
      console.log(`[web] chat model: ${config.model}`)
    } catch (error) {
      this.chatUnavailable = `LLM failed to start: ${(error as Error).message}`
      console.warn(`[web] ${this.chatUnavailable}`)
    }
  }

  public constructor(private readonly deps: McpPathDeps) {}

  /** Called by /api/engage once the entry is VERIFIED: connect to what the verified card says. */
  public async engage(entry: AiCatalogEntry, servingDomain: string, card: unknown): Promise<Connected> {
    const transportUrl = (card as { transport?: { url?: unknown } } | undefined)?.transport?.url
    const connected: Connected =
      typeof transportUrl === 'string'
        ? { url: transportUrl, source: 'verified card' }
        : { url: `${this.deps.envMcpUrl}/mcp`, source: 'env fallback' }

    await this.deps.mcp.connect(connected.url)
    this.engagement = { identifier: entry.identifier, displayName: entry.displayName, servingDomain }
    this.connected = connected
    this.deps.audit.record('authorization', entry.displayName, `MCP client connected to ${connected.url}`, {
      source: connected.source,
    })
    return connected
  }

  /**
   * The per-call gate. Fail closed: a missing engagement, an entry that vanished from the
   * catalog and any verdict but VERIFIED refuse the call, and the refusal is audited with the
   * fresh verdict.
   */
  public async gate(context: { tool: string; via: GateVia }): Promise<GateResult> {
    const { audit } = this.deps
    const engagement = this.engagement
    if (!engagement) {
      const refusal = audit.record('engagement_refused', 'MCP', 'NOT_ENGAGED', { reason: NOT_ENGAGED, ...context })
      return { ok: false, verdict: 'NOT_ENGAGED', auditId: refusal.id, reason: NOT_ENGAGED }
    }

    let result: VerificationResult | undefined
    try {
      // Only the engaged publisher's catalog: the entry is re-fetched from where it was engaged.
      const { results } = await this.deps.discover(engagement.servingDomain)
      const target = results.find((item) => item.entry.identifier === engagement.identifier)
      if (target) {
        result = await verifyEntry(
          target.entry,
          { servingDomain: target.servingDomain },
          await this.deps.verifierOptions()
        )
      }
    } catch (error) {
      console.warn(`[web] the gate could not re-verify: ${(error as Error).message}`)
    }
    if (!result) {
      const reason = 'the engaged entry could not be re-fetched from its publisher and re-verified'
      const refusal = audit.record('engagement_refused', engagement.identifier, 'UNAVAILABLE', { reason, ...context })
      return { ok: false, verdict: 'UNAVAILABLE', auditId: refusal.id, reason }
    }

    if (result.verdict === Verdict.Verified) return { ok: true, verdict: 'VERIFIED', verifiedAt: result.verifiedAt }

    const verification = audit.record('verification', engagement.displayName, result.verdict, result.evidence)
    const reason = 'resource is not VERIFIED at call time'
    const refusal = audit.record('engagement_refused', engagement.identifier, result.verdict, {
      reason,
      verdict: result.verdict,
      verificationAuditId: verification.id,
      ...context,
    })
    return { ok: false, verdict: result.verdict, auditId: refusal.id, reason }
  }

  public mount(app: express.Express): void {
    const { audit, mcp, tasks, walletLink } = this.deps

    app.get('/api/mcp/tools', async (_req, res) => {
      if (!this.engagement) {
        // A listing is not a trust decision, so this precondition is not audited; calls are.
        res.status(403).json({ error: 'refused: not engaged', reason: NOT_ENGAGED })
        return
      }
      try {
        res.json({
          tools: await mcp.listTools(),
          token: mcp.tokenStatus,
          connected: this.connected,
          engaged: this.engagement,
        })
      } catch (error) {
        res.status(502).json({ error: `MCP server unreachable: ${(error as Error).message}` })
      }
    })

    app.post('/api/mcp/call', async (req, res) => {
      const tool = String(req.body?.tool ?? '')
      const args = (req.body?.args ?? {}) as Record<string, unknown>

      try {
        const gate = await this.gate({ tool, via: 'direct call' })
        if (!gate.ok) {
          res
            .status(403)
            .json({ error: 'refused: not verified', verdict: gate.verdict, reason: gate.reason, auditId: gate.auditId })
          return
        }

        const outcome = await mcp.callTool(tool, args)

        if (outcome.ok) {
          audit.record('authorization', `MCP · ${tool}`, 'tool call succeeded', {
            via: 'direct call',
            authorizedBy: outcome.result.authorizedBy,
            verdict: gate.verdict,
            verifiedAt: gate.verifiedAt,
          })
          res.json({ ok: true, result: outcome.result, token: mcp.tokenStatus })
          return
        }

        if (outcome.status === 'error') {
          // Unknown tool or bad arguments: the server said so in JSON-RPC, and no step-up starts.
          res.status(400).json({ ok: false, status: 'error', error: outcome.message })
          return
        }

        // The server named a scope it wants: a challenge, not a refusal — the SDK has started a
        // step-up the operator can satisfy, and only its outcome is a decision.
        audit.record(
          'authorization',
          `MCP · ${tool}`,
          `step-up required (${outcome.status === 403 ? 'insufficient scope' : 'unauthorized'})`,
          { via: 'direct call', requiredScope: outcome.requiredScope }
        )
        res.json({
          ok: false,
          status: outcome.status,
          requiredScope: outcome.requiredScope,
          authorization: authorizationView(outcome.pending),
        })
      } catch (error) {
        res.status(502).json({ error: (error as Error).message })
      }
    })

    /** Push the AS's OID4VP request to the operator's phone over DIDComm. */
    app.post('/api/mcp/send-to-wallet', async (_req, res) => {
      const pending = mcp.pending
      if (!pending) {
        res.status(409).json({ error: 'no authorization is in progress' })
        return
      }
      if (!walletLink.status.linked) {
        res.status(409).json({ error: 'no wallet linked — paste the wallet’s Public DID first' })
        return
      }

      pending.source = 'wallet'
      pending.delivery = await deliverToWallet({
        subject: `MCP · ${pending.scope}`,
        content: pending.authorizationRequest,
        deliver: (content) => walletLink.send(content),
        audit,
        previous: pending.delivery,
      })
      res.status(pending.delivery.state === 'sent' ? 200 : 502).json({ delivery: pending.delivery })
    })

    /**
     * Present the officer credential to the AS from the in-process holder. Labelled as simulated in
     * the UI and in the audit, exactly as the A2A route is — who presented is the subject of the demo.
     */
    app.post('/api/mcp/simulate-presentation', async (_req, res) => {
      const pending = mcp.pending
      if (!pending) {
        res.status(409).json({ error: 'no authorization is in progress' })
        return
      }

      try {
        // Set before presenting: the next poll may land before `present` returns.
        pending.source = 'simulated'
        await tasks.presentToAuthorizationServer(pending.authorizationRequest)
        audit.record('authorization', `MCP · ${pending.scope}`, 'presentation submitted (simulated holder)', {
          note: 'in-process holder, not the operator’s phone',
        })
        res.json({ ok: true })
      } catch (error) {
        res.status(500).json({ error: (error as Error).message })
      }
    })

    /** Poll the AS, exchange the code, and report whether a token was obtained — and against what. */
    app.get('/api/mcp/authorization', async (_req, res) => {
      const pending = mcp.pending
      if (!pending) {
        res.status(409).json({ error: 'no authorization is in progress' })
        return
      }

      try {
        const poll = await mcp.pollAuthorization()
        if (poll.granted) {
          audit.record(
            'authorization',
            `MCP · ${pending.scope}`,
            'scoped token issued against a verified presentation',
            {
              ttlSeconds: mcp.tokenStatus.expiresInSeconds,
              resource: pending.resource,
              presentation: poll.presentation,
            }
          )
          this.onDecision()
        }
        res.json({
          granted: poll.granted,
          token: mcp.tokenStatus,
          delivery: pending.delivery,
          session: poll.session,
          presentation: poll.presentation,
          authorization: authorizationView(pending),
        })
      } catch (error) {
        const message = (error as Error).message
        // The AS or Heka is down: nothing was decided, the step-up stays pending and the UI keeps
        // polling. Recorded once per step-up, as what it is — not as a refusal of anyone.
        if (error instanceof AuthorizationUnavailableError) {
          if (!pending.unavailableAudited) {
            pending.unavailableAudited = true
            audit.record('engagement_refused', `MCP · ${pending.scope}`, 'UNAVAILABLE', {
              reason: message,
              note: 'the step-up stays pending; polling continues',
            })
          }
          res.status(503).json({ error: message, retrying: true })
          return
        }
        if (error instanceof AuthorizationDeniedError) {
          const { presentation } = error
          audit.record('denial', `MCP · ${pending.scope}`, message, presentation ? { presentation } : undefined)
          this.onDecision()
          res.status(403).json({ error: message, presentation })
          return
        }
        // The AS lost the request, or the code exchange failed: over, but nobody refused a credential.
        audit.record('engagement_refused', `MCP · ${pending.scope}`, 'UNAVAILABLE', { reason: message })
        this.onDecision()
        res.status(410).json({ error: message })
      }
    })

    /**
     * Drop the cached access token. Revoking a credential stops the *next* grant — a token already
     * minted stays valid until it expires, exactly as OAuth intends — so showing the kill switch
     * means getting rid of the token first.
     */
    app.delete('/api/mcp/token', (_req, res) => {
      const before = mcp.tokenStatus
      mcp.forgetToken()
      audit.record('authorization', 'MCP · token', 'cached access token dropped by the operator', {
        hadToken: before.present,
        expiresInSeconds: before.expiresInSeconds,
      })
      res.json({ token: mcp.tokenStatus })
    })

    // ---------- chat ----------

    app.get('/api/chat', (_req, res) => {
      const chat = this.chat
      if (!chat) {
        res.json({
          available: false,
          reason: this.chatUnavailable,
          state: 'idle',
          steps: [],
          engaged: Boolean(this.engagement),
        })
        return
      }
      const pending = mcp.pending
      res.json({
        ...chat.view,
        engaged: Boolean(this.engagement),
        // The panel data for the paused step — the same shape /api/mcp/call returns.
        authorization: chat.state === 'paused-authorization' && pending ? authorizationView(pending) : undefined,
      })
    })

    app.post('/api/chat', (req, res) => {
      const chat = this.chat
      if (!chat) {
        res.status(503).json({ error: this.chatUnavailable, reason: this.chatUnavailable })
        return
      }
      if (!this.engagement) {
        res.status(403).json({ error: 'refused: not engaged', reason: NOT_ENGAGED })
        return
      }
      const message = String(req.body?.message ?? '').trim()
      if (!message) {
        res.status(400).json({ error: 'message is required' })
        return
      }
      try {
        chat.send(message)
        res.status(202).json({ accepted: true, state: chat.state })
      } catch (error) {
        res.status(409).json({ error: (error as Error).message })
      }
    })

    app.post('/api/chat/resume', (_req, res) => {
      const chat = this.chat
      if (!chat) {
        res.status(503).json({ error: this.chatUnavailable })
        return
      }
      try {
        chat.resume()
        res.status(202).json({ accepted: true, state: chat.state })
      } catch (error) {
        res.status(409).json({ error: (error as Error).message })
      }
    })

    app.post('/api/chat/reset', (_req, res) => {
      if (!this.chat) {
        res.status(503).json({ error: this.chatUnavailable })
        return
      }
      this.chat.reset()
      res.json({ ok: true })
    })
  }

  /** A step-up is over, decided or not: a chat paused on it continues on its own. */
  private onDecision(): void {
    if (this.chat?.state === 'paused-authorization') this.chat.resume()
  }
}
