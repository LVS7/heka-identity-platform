/**
 * Authorization Server for the MCP path — OAuth 2.1, with a credential presentation where the
 * login form would normally be.
 *
 * This is the composition the demo is arguing for: MCP's own authorization architecture,
 * unchanged on the wire, with the grant backed by an OID4VP presentation. No bespoke protocol —
 * an MCP client that knows nothing about verifiable credentials still works, because everything
 * VC-shaped happens inside the interaction step the AS already owns.
 *
 * Deliberately hand-rolled rather than node-oidc-provider: the point is that the flow be
 * *readable*, and the subset MCP requires is small — metadata, authorization code with PKCE and
 * a resource indicator, token, JWKS.
 *
 * Not production. Codes and grants live in memory, client ids are not validated, and there is no
 * consent screen beyond the presentation itself. The process entry point is ./auth-server.ts.
 */

import { createHash, randomUUID } from 'node:crypto'

import express from 'express'
import { exportJWK, generateKeyPair, SignJWT, type JWK, type CryptoKey } from 'jose'

import { ROLE_CREDENTIAL_VCT } from '../core/types'
import { loadState } from '../seed/state'
import { OFFICER_CREDENTIAL } from '../shared/demo-config'
import { IdentityServiceClient, VerificationSessionRecord } from '../shared/identity-service'
import {
  evaluateOfficerPresentation,
  officerPresentationDefinition,
  PresentationRefused,
  PresentedCredential,
  StatusCheck,
} from '../shared/presented-credential'
import { authorizedResult, deniedResult, requestedFromDefinition } from '../shared/authorization-result'
import { InTaskOpenId4VpAuthorizationResult, InTaskOpenId4VpRequested } from '../agent/extension'

/** The scope that guards the sensitive tool. */
export const SUPPLIERS_EXPORT_SCOPE = 'suppliers:export'

/** An abandoned request is forgotten after this; the verifier session behind it is long gone. */
const PENDING_TTL_MS = 10 * 60_000

export interface AuthorizationServerOptions {
  /** This AS's issuer identifier, also the base of every endpoint it advertises. */
  issuer: string
  /** Short by design: a revoked credential must stop mattering within minutes, not hours. */
  tokenTtlSeconds: number
}

interface PendingAuthorization {
  clientId: string
  redirectUri: string
  codeChallenge: string
  state?: string
  scope: string
  /** RFC 8707: which resource the token is for. Bound into the token's audience. */
  resource: string
  verificationSessionId: string
  authorizationRequest: string
  createdAt: number
}

interface IssuedCode {
  authorization: PendingAuthorization
  claims: { role: string; org: string }
}

/** Ask for the same officer credential the A2A path uses — one credential, two protocols. */
const OFFICER_PRESENTATION_DEFINITION = officerPresentationDefinition('Authorize export of supplier bank details')

/** The definition in plain fields for the client (demo addition, mirrored from the A2A extension). */
const OFFICER_REQUESTED = requestedFromDefinition(OFFICER_PRESENTATION_DEFINITION)

export type AuthorizationPoll =
  | { state: 'pending'; session: { id: string; state: string } }
  | {
      state: 'granted'
      session: { id: string; state: string }
      code: string
      redirectTo: string
      presentation: InTaskOpenId4VpAuthorizationResult
    }
  | {
      state: 'denied'
      session?: { id: string; state: string }
      reason: string
      presentation?: InTaskOpenId4VpAuthorizationResult
    }
  /** Heka could not be read: nothing was decided and the request stays open. */
  | { state: 'unavailable'; reason: string }
  /** Unknown here — never issued, already decided, or abandoned past its lifetime. */
  | { state: 'expired' }

export class AuthorizationServer {
  private readonly pending = new Map<string, PendingAuthorization>()
  private readonly codes = new Map<string, IssuedCode>()

  private signingKey!: CryptoKey
  private publicJwk!: JWK
  private readonly keyId = randomUUID()
  private verifierDid!: string

  public constructor(
    private readonly identityService: IdentityServiceClient,
    private readonly options: AuthorizationServerOptions
  ) {}

  public async initialize(): Promise<void> {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true })
    this.signingKey = privateKey as CryptoKey
    this.publicJwk = { ...(await exportJWK(publicKey)), kid: this.keyId, alg: 'ES256', use: 'sig' }

    this.verifierDid = await this.identityService.prepareWallet()
    console.log(`[as] verifier identity: ${this.verifierDid}`)
  }

  public jwks() {
    return { keys: [this.publicJwk] }
  }

  /** RFC 8414 — what an MCP client reads to learn how to talk to us. */
  public metadata() {
    const issuer = this.options.issuer
    return {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [SUPPLIERS_EXPORT_SCOPE],
      authorization_response_iss_parameter_supported: true,
    }
  }

  /** Begin an authorization: create the verification session the user will satisfy. */
  public async beginAuthorization(params: {
    clientId: string
    redirectUri: string
    codeChallenge: string
    state?: string
    scope: string
    resource: string
  }): Promise<{
    requestId: string
    authorizationRequest: string
    session: { id: string; state: string }
    requested: InTaskOpenId4VpRequested
  }> {
    const session = await this.identityService.createVerificationSession({
      publicVerifierId: this.verifierDid,
      requestSigner: { method: 'did', did: this.verifierDid },
      presentationExchange: { definition: OFFICER_PRESENTATION_DEFINITION },
    })

    const requestId = randomUUID()
    this.pending.set(requestId, {
      ...params,
      verificationSessionId: session.verificationSession.id,
      authorizationRequest: session.authorizationRequest,
      createdAt: Date.now(),
    })

    console.log(`[as] authorization ${requestId.slice(0, 8)} awaiting a presentation`)
    return {
      requestId,
      authorizationRequest: session.authorizationRequest,
      session: { id: session.verificationSession.id, state: session.verificationSession.state },
      requested: OFFICER_REQUESTED,
    }
  }

  /**
   * Answer a poll: how far the wallet has got, or the decision.
   *
   * Heka confirms the presentation is sound; whose credential it is, of what type, and whether
   * it is still live is this server's decision (src/shared/presented-credential.ts). Skipping
   * that would make the officer credential's revocation meaningless on this path.
   */
  public async pollAuthorization(requestId: string): Promise<AuthorizationPoll> {
    const authorization = this.pending.get(requestId)
    if (!authorization) return { state: 'expired' }
    if (Date.now() - authorization.createdAt > PENDING_TTL_MS) {
      this.pending.delete(requestId)
      return { state: 'expired' }
    }

    let session: VerificationSessionRecord
    try {
      session = await this.identityService.getVerificationSession(authorization.verificationSessionId)
    } catch (error) {
      // Heka unreachable is not a decision about anyone's credential: the request stays open and the
      // client polls again. Only a refusal below ends it.
      return { state: 'unavailable', reason: (error as Error).message }
    }
    // "Not yet" is a normal poll result and the request stays open; the client learns how far the wallet got.
    if (session.state !== 'ResponseVerified') {
      return { state: 'pending', session: { id: session.id, state: session.state } }
    }

    let presented: PresentedCredential
    let status: StatusCheck
    try {
      ;({ presented, status } = await evaluateOfficerPresentation(session, {
        trustedIssuer: loadState().issuerDid,
        statusListOrigin: this.identityService.baseOrigin,
        log: (line) => console.log(`[as] ${line}`),
      }))
    } catch (error) {
      if (!(error instanceof PresentationRefused)) throw error
      // A refusal is a decision: the request is over, so a later poll cannot re-ask and get a different answer.
      this.pending.delete(requestId)
      console.log(`[as] authorization ${requestId.slice(0, 8)} refused (${error.reason}): ${error.message}`)
      return {
        state: 'denied',
        session: { id: session.id, state: session.state },
        reason: error.message,
        presentation: deniedResult(session.id, error.message, error.presented, error.reason),
      }
    }

    // The role was required by the evaluation; the organisation is only asked for, so check it here.
    const { role, org } = presented.claims
    if (typeof org !== 'string') {
      this.pending.delete(requestId)
      const reason = 'the presentation did not disclose the organisation'
      return {
        state: 'denied',
        session: { id: session.id, state: session.state },
        reason,
        presentation: deniedResult(session.id, reason, presented),
      }
    }
    const claims = { role: String(role), org }

    // Built before anything is stored, so a redirect that does not parse cannot strand a code.
    const code = randomUUID()
    const redirectTo = new URL(authorization.redirectUri)
    this.codes.set(code, { authorization, claims })
    this.pending.delete(requestId)

    redirectTo.searchParams.set('code', code)
    redirectTo.searchParams.set('iss', this.options.issuer) // RFC 9207
    if (authorization.state) redirectTo.searchParams.set('state', authorization.state)

    console.log(`[as] authorization ${requestId.slice(0, 8)} granted to ${claims.role}`)
    return {
      state: 'granted',
      session: { id: session.id, state: session.state },
      code,
      redirectTo: redirectTo.toString(),
      presentation: authorizedResult(presented, status),
    }
  }

  /** Exchange a code for an access token, verifying PKCE. */
  public async exchangeCode(params: {
    code: string
    codeVerifier: string
    redirectUri: string
    resource?: string
  }): Promise<{ access_token: string; token_type: 'Bearer'; expires_in: number; scope: string }> {
    const issued = this.codes.get(params.code)
    if (!issued) throw new Error('invalid_grant')
    this.codes.delete(params.code) // single use

    const { authorization, claims } = issued
    const ttl = this.options.tokenTtlSeconds

    const challenge = createHash('sha256').update(params.codeVerifier).digest('base64url')
    if (challenge !== authorization.codeChallenge) throw new Error('invalid_grant: PKCE verification failed')
    if (params.redirectUri !== authorization.redirectUri) throw new Error('invalid_grant: redirect_uri mismatch')

    // RFC 8707: the token is only valid at the resource it was requested for.
    const audience = params.resource ?? authorization.resource

    const accessToken = await new SignJWT({
      scope: authorization.scope,
      client_id: authorization.clientId,
      // The verified claims travel with the token: the resource server learns *who* authorized,
      // not merely that someone did.
      role: claims.role,
      org: claims.org,
      credential_type: ROLE_CREDENTIAL_VCT,
    })
      .setProtectedHeader({ alg: 'ES256', kid: this.keyId })
      .setIssuer(this.options.issuer)
      .setAudience(audience)
      .setSubject(`${claims.role}@${claims.org}`)
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`)
      .setJti(randomUUID())
      .sign(this.signingKey)

    console.log(`[as] token issued: scope=${authorization.scope} aud=${audience} ttl=${ttl}s`)
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ttl,
      scope: authorization.scope,
    }
  }
}

/** The AS's HTTP surface; ./auth-server.ts only adds the environment and listens. */
export function createAuthorizationApp(as: AuthorizationServer): express.Express {
  const app = express()
  app.use(express.json())
  app.use(express.urlencoded({ extended: true }))

  app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(as.metadata()))
  app.get('/jwks', (_req, res) => res.json(as.jwks()))

  /**
   * The authorization endpoint. Instead of a password form it returns the OID4VP request the
   * user satisfies with their wallet; the client polls /authorize/:id until a code is ready.
   */
  app.get('/authorize', async (req, res) => {
    const { client_id, redirect_uri, code_challenge, code_challenge_method, state, scope, resource } = req.query

    if (code_challenge_method !== 'S256' || !code_challenge) {
      res.status(400).json({ error: 'invalid_request', error_description: 'PKCE with S256 is required' })
      return
    }
    if (!redirect_uri || !resource || !URL.canParse(String(redirect_uri))) {
      res
        .status(400)
        .json({ error: 'invalid_request', error_description: 'redirect_uri (a URL) and resource are required' })
      return
    }

    try {
      const { requestId, authorizationRequest, session, requested } = await as.beginAuthorization({
        clientId: String(client_id ?? 'trust-lens'),
        redirectUri: String(redirect_uri),
        codeChallenge: String(code_challenge),
        state: state ? String(state) : undefined,
        scope: String(scope ?? SUPPLIERS_EXPORT_SCOPE),
        resource: String(resource),
      })

      res.json({
        requestId,
        interaction: 'openid4vp',
        authorizationRequest,
        // Demo additions, mirrored from the A2A extension: where the wallet is, and what is asked.
        session,
        requested,
        message: `Present a ${OFFICER_CREDENTIAL.role} credential to authorize scope "${scope ?? SUPPLIERS_EXPORT_SCOPE}"`,
      })
    } catch (error) {
      res.status(500).json({ error: 'server_error', error_description: (error as Error).message })
    }
  })

  /** Poll: how far has the wallet got, and may we have the code? */
  app.get('/authorize/:requestId', async (req, res) => {
    try {
      const poll = await as.pollAuthorization(req.params.requestId)
      if (poll.state === 'expired') {
        res.status(404).json({ error: 'invalid_request', error_description: 'unknown authorization request' })
        return
      }
      // 503, not 403: a client must not read an outage as a person being refused.
      if (poll.state === 'unavailable') {
        res.status(503).json({ error: 'temporarily_unavailable', error_description: poll.reason })
        return
      }
      if (poll.state === 'pending') {
        res.json({ status: 'pending', session: poll.session })
        return
      }
      if (poll.state === 'denied') {
        res.status(403).json({
          error: 'access_denied',
          error_description: poll.reason,
          session: poll.session,
          presentation: poll.presentation,
        })
        return
      }
      res.json({
        status: 'granted',
        session: poll.session,
        code: poll.code,
        redirectTo: poll.redirectTo,
        presentation: poll.presentation,
      })
    } catch (error) {
      // Unexpected, and still no code: the client keeps waiting or gives up, but nobody was refused.
      res.status(500).json({ error: 'server_error', error_description: (error as Error).message })
    }
  })

  app.post('/token', async (req, res) => {
    const { grant_type, code, code_verifier, redirect_uri, resource } = req.body ?? {}

    if (grant_type !== 'authorization_code') {
      res.status(400).json({ error: 'unsupported_grant_type' })
      return
    }

    try {
      res.json(
        await as.exchangeCode({
          code: String(code),
          codeVerifier: String(code_verifier),
          redirectUri: String(redirect_uri),
          resource: resource ? String(resource) : undefined,
        })
      )
    } catch (error) {
      res.status(400).json({ error: 'invalid_grant', error_description: (error as Error).message })
    }
  })

  return app
}
