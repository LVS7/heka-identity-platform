/**
 * The orchestrator's MCP client, including the step-up authorization flow.
 *
 * It walks the discovery chain the MCP spec defines and nothing else:
 *
 *   call tool → 401/403 with WWW-Authenticate
 *             → RFC 9728 protected resource metadata (which AS guards this?)
 *             → RFC 8414 authorization server metadata (how do I talk to it?)
 *             → authorization with PKCE + RFC 8707 resource
 *             → [the AS asks for a credential presentation]
 *             → token → retry
 *
 * Note what is absent: any knowledge of verifiable credentials. The client sees an ordinary
 * OAuth interaction it cannot complete on its own, so it surfaces it to the operator. That the
 * interaction happens to be an OID4VP presentation is entirely the authorization server's
 * business — which is the whole argument for composing them this way.
 */

import { createHash, randomBytes } from 'node:crypto'

export interface ToolCallOutcome {
  status: number
  ok: boolean
  body: unknown
  /** Set when the server refused and named a scope we could step up to. */
  requiredScope?: string
  resourceMetadataUrl?: string
}

export interface PendingAuthorization {
  requestId: string
  authorizationRequest: string
  authorizeUrl: string
  codeVerifier: string
  redirectUri: string
  resource: string
  scope: string
  message?: string
}

const REDIRECT_URI = 'http://localhost:4000/oauth/callback'
const CLIENT_ID = 'trust-lens'

function parseChallenge(header: string | null): Record<string, string> {
  if (!header) return {}
  const params: Record<string, string> = {}
  for (const match of header.matchAll(/(\w+)="([^"]*)"/g)) params[match[1]] = match[2]
  return params
}

export class McpClient {
  private accessToken?: string
  private tokenExpiresAt = 0

  public constructor(private readonly serverUrl: string) {}

  public get tokenStatus(): { present: boolean; expiresInSeconds: number } {
    const remaining = Math.max(0, Math.round((this.tokenExpiresAt - Date.now()) / 1000))
    return { present: Boolean(this.accessToken) && remaining > 0, expiresInSeconds: remaining }
  }

  public forgetToken(): void {
    this.accessToken = undefined
    this.tokenExpiresAt = 0
  }

  public async listTools(): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.serverUrl}/tools`)
    return (await response.json()) as Record<string, unknown>
  }

  public async callTool(name: string): Promise<ToolCallOutcome> {
    const headers: Record<string, string> = {}
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      headers.authorization = `Bearer ${this.accessToken}`
    }

    const response = await fetch(`${this.serverUrl}/tools/${name}`, { method: 'POST', headers })
    const body = await response.json().catch(() => ({}))

    if (response.ok) return { status: response.status, ok: true, body }

    const challenge = parseChallenge(response.headers.get('www-authenticate'))
    return {
      status: response.status,
      ok: false,
      body,
      requiredScope: challenge.scope,
      resourceMetadataUrl: challenge.resource_metadata,
    }
  }

  /** Begin a step-up: discover the AS, then start an authorization the operator must satisfy. */
  public async beginAuthorization(outcome: ToolCallOutcome): Promise<PendingAuthorization> {
    const metadataUrl = outcome.resourceMetadataUrl ?? `${this.serverUrl}/.well-known/oauth-protected-resource`
    const resourceMetadata = (await (await fetch(metadataUrl)).json()) as {
      resource: string
      authorization_servers: string[]
    }

    const authorizationServer = resourceMetadata.authorization_servers[0]
    const asMetadata = (await (
      await fetch(`${authorizationServer}/.well-known/oauth-authorization-server`)
    ).json()) as { authorization_endpoint: string; token_endpoint: string }

    // PKCE: the verifier never leaves this process.
    const codeVerifier = randomBytes(32).toString('base64url')
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')

    const scope = outcome.requiredScope ?? 'suppliers:export'
    const authorizeUrl = new URL(asMetadata.authorization_endpoint)
    authorizeUrl.searchParams.set('client_id', CLIENT_ID)
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI)
    authorizeUrl.searchParams.set('code_challenge', codeChallenge)
    authorizeUrl.searchParams.set('code_challenge_method', 'S256')
    authorizeUrl.searchParams.set('scope', scope)
    // RFC 8707 — bind the token to this resource, so it is useless anywhere else.
    authorizeUrl.searchParams.set('resource', resourceMetadata.resource)

    const started = (await (await fetch(authorizeUrl.toString())).json()) as {
      requestId: string
      authorizationRequest: string
      message?: string
    }

    return {
      requestId: started.requestId,
      authorizationRequest: started.authorizationRequest,
      authorizeUrl: authorizeUrl.origin,
      codeVerifier,
      redirectUri: REDIRECT_URI,
      resource: resourceMetadata.resource,
      scope,
      message: started.message,
    }
  }

  /**
   * Ask the AS whether the presentation has landed. Returns false while still waiting; throws
   * when the AS refuses (a revoked credential arrives here).
   */
  public async completeAuthorization(pending: PendingAuthorization): Promise<boolean> {
    const response = await fetch(`${pending.authorizeUrl}/authorize/${pending.requestId}`)
    const body = (await response.json()) as { status?: string; code?: string; error_description?: string }

    if (response.status === 403) throw new Error(body.error_description ?? 'authorization denied')
    if (body.status !== 'granted' || !body.code) return false

    const tokenResponse = await fetch(`${pending.authorizeUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: body.code,
        code_verifier: pending.codeVerifier,
        redirect_uri: pending.redirectUri,
        resource: pending.resource,
      }),
    })

    const token = (await tokenResponse.json()) as { access_token?: string; expires_in?: number; error_description?: string }
    if (!token.access_token) throw new Error(token.error_description ?? 'token request failed')

    this.accessToken = token.access_token
    this.tokenExpiresAt = Date.now() + (token.expires_in ?? 300) * 1000
    return true
  }
}
