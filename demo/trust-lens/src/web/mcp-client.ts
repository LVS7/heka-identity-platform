/**
 * The orchestrator's MCP client: the SDK's `Client` over Streamable HTTP, with the step-up
 * handled by the SDK's own auth chain and our provider (./oauth-provider.ts).
 *
 *   call tool → 401/403 with WWW-Authenticate
 *             → RFC 9728 protected resource metadata (which AS guards this?)
 *             → RFC 8414 authorization server metadata (how do I talk to it?)
 *             → authorization with PKCE + RFC 8707 resource
 *             → [the AS asks for a credential presentation — the provider keeps it pending]
 *             → poll → code → token → retry
 *
 * What the AS says about the presentation afterwards (`session`, `presentation`) is a demo
 * addition mirrored from the A2A extension; the client passes it through for display and audit.
 */

import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpError } from '@modelcontextprotocol/sdk/types.js'

import { InTaskOpenId4VpAuthorizationResult } from '../agent/extension'
import { PendingAuthorization, TrustLensOAuthProvider } from './oauth-provider'
import { presentationFrom, PresentationView } from './presentation'

export interface McpTool {
  name: string
  description?: string
  /** From the tool's `_meta.requiredScope`; null when the tool needs no elevated scope. */
  requiredScope: string | null
  inputSchema: Record<string, unknown>
}

export interface ToolResult {
  rows: unknown[]
  authorizedBy?: { role?: string; org?: string }
}

export type ToolOutcome =
  | { ok: true; result: ToolResult }
  | { ok: false; status: 401 | 403; requiredScope: string; pending: PendingAuthorization }
  | { ok: false; status: 'error'; message: string }

export interface AuthorizationPoll {
  granted: boolean
  session?: { id: string; state: string }
  presentation?: PresentationView
}

/** How the last step-up ended; the chat reads it to know whether a paused call may be retried. */
export interface AuthorizationDecision {
  at: string
  granted: boolean
  reason?: string
  presentation?: PresentationView
}

/** The AS refused: a revoked or untrusted credential arrives here, with what was refused when known. */
export class AuthorizationDeniedError extends Error {
  public constructor(
    message: string,
    public readonly presentation?: PresentationView
  ) {
    super(message)
    this.name = 'AuthorizationDeniedError'
  }
}

function textOf(result: unknown): string {
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type: 'text'; text: string } => (part as { type?: string }).type === 'text')
    .map((part) => part.text)
    .join('\n')
}

export class McpConnection {
  private client?: Client
  private transport?: StreamableHTTPClientTransport
  private serverUrl?: string
  /** Status of the last refusal seen on the wire — the SDK's UnauthorizedError does not say which. */
  private lastRefusal: 401 | 403 = 401
  public lastDecision?: AuthorizationDecision

  public constructor(
    public readonly provider: TrustLensOAuthProvider,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  public get url(): string | undefined {
    return this.serverUrl
  }

  public get connected(): boolean {
    return Boolean(this.client)
  }

  public get pending(): PendingAuthorization | undefined {
    return this.provider.pending
  }

  public get tokenStatus(): { present: boolean; expiresInSeconds: number } {
    return this.provider.tokenStatus
  }

  public forgetToken(): void {
    this.provider.forgetToken()
  }

  /** Connect (initialize) to the MCP endpoint. Anonymous: nothing before a scoped tools/call needs a token. */
  public async connect(url: string): Promise<void> {
    await this.close()
    const observe: typeof fetch = async (input, init) => {
      const response = await this.fetchFn(input, init)
      if (response.status === 401 || response.status === 403) this.lastRefusal = response.status
      return response
    }
    const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: this.provider, fetch: observe })
    const client = new Client({ name: 'trust-lens', version: '1.0.0' })
    await client.connect(transport)
    this.client = client
    this.transport = transport
    this.serverUrl = url
  }

  public async close(): Promise<void> {
    const client = this.client
    this.client = undefined
    this.transport = undefined
    this.serverUrl = undefined
    await client?.close().catch(() => undefined)
  }

  private requireClient(): Client {
    if (!this.client) throw new Error('not connected to an MCP server — engage the MCP entry first')
    return this.client
  }

  public async listTools(): Promise<McpTool[]> {
    const { tools } = await this.requireClient().listTools()
    return tools.map((tool) => {
      const meta = (tool._meta ?? {}) as { requiredScope?: unknown }
      return {
        name: tool.name,
        description: tool.description,
        requiredScope: typeof meta.requiredScope === 'string' ? meta.requiredScope : null,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }
    })
  }

  /**
   * Call a tool. A 401/403 has already been turned into a pending step-up by the SDK and the
   * provider by the time the UnauthorizedError arrives here; a tool error (unknown tool, bad
   * arguments) is reported as such and never starts a step-up.
   */
  public async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
    try {
      const result = await this.requireClient().callTool({ name, arguments: args })
      if (result.isError) return { ok: false, status: 'error', message: textOf(result) || 'tool error' }
      const parsed = JSON.parse(textOf(result)) as ToolResult
      return { ok: true, result: parsed }
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        const pending = this.provider.pending
        if (!pending) {
          return { ok: false, status: 'error', message: 'authorization required, but no step-up could be started' }
        }
        return { ok: false, status: this.lastRefusal, requiredScope: pending.scope, pending }
      }
      if (error instanceof McpError) return { ok: false, status: 'error', message: error.message }
      throw error
    }
  }

  /**
   * Ask the AS whether the presentation has landed. `granted: false` while still waiting (with
   * the session's state); on a grant the code is exchanged through the SDK (`finishAuth`, with
   * the saved verifier) and the pending entry cleared; a refusal throws `AuthorizationDeniedError`
   * (a revoked credential arrives here). Any outcome other than "still waiting" ends the step-up.
   */
  public async pollAuthorization(): Promise<AuthorizationPoll> {
    const pending = this.provider.pending
    if (!pending) throw new Error('no authorization is in progress')

    try {
      return await this.poll(pending)
    } catch (error) {
      this.provider.clearPending()
      throw error
    }
  }

  private async poll(pending: PendingAuthorization): Promise<AuthorizationPoll> {
    const response = await this.fetchFn(`${pending.authorizeOrigin}/authorize/${pending.requestId}`)
    const body = (await response.json().catch(() => ({}))) as {
      status?: string
      code?: string
      error_description?: string
      session?: { id: string; state: string }
      presentation?: InTaskOpenId4VpAuthorizationResult
    }

    // A token that arrived with nothing pressed on this side was scanned from the QR.
    const source = pending.source ?? 'qr'
    const presentation = body.presentation && presentationFrom(body.presentation, source)

    if (response.status === 403) {
      const reason = body.error_description ?? 'authorization denied'
      this.lastDecision = { at: new Date().toISOString(), granted: false, reason, presentation }
      throw new AuthorizationDeniedError(reason, presentation)
    }
    if (!response.ok) throw new Error(body.error_description ?? `the authorization server answered ${response.status}`)
    if (body.status !== 'granted' || !body.code) {
      if (body.session) pending.session = body.session
      return { granted: false, session: pending.session }
    }

    if (!this.transport) throw new Error('not connected to an MCP server')
    await this.transport.finishAuth(body.code)
    this.provider.clearPending()
    this.lastDecision = { at: new Date().toISOString(), granted: true, presentation }
    return { granted: true, session: body.session ?? pending.session, presentation }
  }
}
