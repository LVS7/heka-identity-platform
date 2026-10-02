/**
 * The Trust Lens's OAuth client provider for the SDK's MCP client.
 *
 * The SDK walks the spec's chain on a 401 or a 403 `insufficient_scope` — RFC 9728 protected
 * resource metadata, RFC 8414 authorization server metadata, PKCE — and then calls
 * `redirectToAuthorization(url)` expecting a browser to be sent there. Our authorization server
 * has no page to send anyone to: `GET /authorize` answers JSON with the OID4VP request the person
 * satisfies with their wallet, and the client polls `GET /authorize/:id` for the code. This
 * provider absorbs that: it performs the GET itself, keeps the answer as the pending step-up for
 * the UI, and hands the code back to the SDK through `finishAuth` once the poll is granted.
 *
 * Note what is absent: any knowledge of verifiable credentials. The client sees an ordinary
 * OAuth interaction it cannot complete on its own and surfaces it to the operator.
 *
 * Tokens, the verifier and the pending request live in memory; one Trust Lens process, one client.
 */

import { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

import { InTaskOpenId4VpRequested } from '../agent/extension'
import { PresentationSource } from './presentation'
import { DeliveryState } from './wallet-delivery'

export interface PendingAuthorization {
  requestId: string
  authorizationRequest: string
  /** Origin of the AS; the poll is `${authorizeOrigin}/authorize/${requestId}`. */
  authorizeOrigin: string
  codeVerifier: string
  scope: string
  resource: string
  startedAt: string
  message?: string
  /** Where the verifier session is, as last reported by the AS (demo addition). */
  session?: { id: string; state: string }
  /** What the AS asks for, in plain fields (demo addition). */
  requested?: InTaskOpenId4VpRequested
  /** Which way the operator chose to present — known only on this side. */
  source?: PresentationSource
  /** Last attempt to push the request to the operator's wallet, if any. */
  delivery?: DeliveryState
  /** The outage during this step-up was audited once; a poll every 2 s must not repeat it. */
  unavailableAudited?: boolean
}

/** Required by the AS and by OAuth, never followed: the AS answers JSON and we poll. */
export const REDIRECT_URL = 'http://localhost:4000/oauth/callback'
export const CLIENT_ID = 'trust-lens'

export class TrustLensOAuthProvider implements OAuthClientProvider {
  public readonly redirectUrl = REDIRECT_URL
  public readonly clientMetadata: OAuthClientMetadata = {
    client_name: 'Trust Lens',
    redirect_uris: [REDIRECT_URL],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: 'suppliers:export',
  }

  private tokenSet?: OAuthTokens
  private tokenExpiresAt = 0
  private verifier?: string
  /** The step-up in progress, if any. One at a time: a second refusal for the same scope joins it. */
  public pending?: PendingAuthorization

  public constructor(private readonly fetchFn: typeof fetch = fetch) {}

  /** A fixed client id: the AS does not validate client ids and offers no dynamic registration. */
  public clientInformation(): OAuthClientInformationMixed {
    return { client_id: CLIENT_ID }
  }

  public tokens(): OAuthTokens | undefined {
    // An expired token is no token: the SDK would send it and the server would answer 401
    // invalid_token, which reads like a broken token rather than an elapsed one.
    return this.tokenStatus.present ? this.tokenSet : undefined
  }

  public saveTokens(tokens: OAuthTokens): void {
    this.tokenSet = tokens
    this.tokenExpiresAt = Date.now() + (tokens.expires_in ?? 300) * 1000
  }

  public saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier
  }

  public codeVerifier(): string {
    if (!this.verifier) throw new Error('no PKCE verifier saved — no authorization was started')
    return this.verifier
  }

  public invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'tokens') this.forgetToken()
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined
  }

  /**
   * "Redirect" to the authorization endpoint: GET it, keep the JSON answer as the pending step-up.
   * A step-up already pending for the same scope and resource is kept — the AS would otherwise
   * accumulate requests nobody will ever answer — and its verifier is restored, because the SDK
   * saved a fresh one just before calling this.
   */
  public async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const scope = authorizationUrl.searchParams.get('scope') ?? ''
    const resource = authorizationUrl.searchParams.get('resource') ?? ''

    const pending = this.pending
    if (pending && pending.scope === scope && pending.resource === resource) {
      this.verifier = pending.codeVerifier
      return
    }

    // Bounded: this runs inside a tool call, and a hung AS would hang the call and the chat behind it.
    const response = await this.fetchFn(authorizationUrl.toString(), { signal: AbortSignal.timeout(10_000) })
    const body = (await response.json().catch(() => ({}))) as {
      requestId?: string
      authorizationRequest?: string
      message?: string
      session?: { id: string; state: string }
      requested?: InTaskOpenId4VpRequested
      error_description?: string
    }
    if (!response.ok || !body.requestId || !body.authorizationRequest) {
      throw new Error(body.error_description ?? `authorization endpoint answered ${response.status}`)
    }

    this.pending = {
      requestId: body.requestId,
      authorizationRequest: body.authorizationRequest,
      authorizeOrigin: authorizationUrl.origin,
      codeVerifier: this.codeVerifier(),
      scope,
      resource,
      startedAt: new Date().toISOString(),
      message: body.message,
      session: body.session,
      requested: body.requested,
    }
  }

  public get tokenStatus(): { present: boolean; expiresInSeconds: number } {
    const remaining = Math.max(0, Math.round((this.tokenExpiresAt - Date.now()) / 1000))
    return { present: Boolean(this.tokenSet) && remaining > 0, expiresInSeconds: remaining }
  }

  public forgetToken(): void {
    this.tokenSet = undefined
    this.tokenExpiresAt = 0
  }

  public clearPending(): void {
    this.pending = undefined
  }
}
