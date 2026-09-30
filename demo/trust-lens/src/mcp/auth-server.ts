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
 * Not production. Codes and grants live in memory, clients are pre-registered, and there is no
 * consent screen beyond the presentation itself.
 */

import { createHash, randomUUID } from 'node:crypto'

import * as dotenv from 'dotenv'
import express from 'express'
import { exportJWK, generateKeyPair, SignJWT, type JWK, type CryptoKey } from 'jose'

import { ROLE_CREDENTIAL_VCT } from '../core/types'
import { loadState } from '../seed/state'
import { OFFICER_CREDENTIAL } from '../shared/demo-config'
import { identityServiceFromEnv, IdentityServiceClient } from '../shared/identity-service'
import {
  assertPresentedCredentialValid,
  PresentationRefused,
  PresentedCredential,
  readPresentedCredential,
  StatusCheck,
  statusListOriginOf,
} from '../shared/presented-credential'

dotenv.config()

const PORT = Number(process.env.AS_PORT ?? 4300)
const ISSUER = process.env.AS_PUBLIC_URL ?? `http://localhost:${PORT}`
/** Short by design: a revoked credential must stop mattering within minutes, not hours. */
const TOKEN_TTL_SECONDS = Number(process.env.AS_TOKEN_TTL ?? 300)

/** The scope that guards the sensitive tool. */
export const SUPPLIERS_EXPORT_SCOPE = 'suppliers:export'

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
  presented: PresentedCredential
  status: StatusCheck
  claims: { role: string; org: string }
}

/** Ask for the same officer credential the A2A path uses — one credential, two protocols. */
const OFFICER_PRESENTATION_DEFINITION = {
  id: 'FinanceDataOfficer',
  name: 'Finance Data Officer',
  purpose: 'Authorize export of supplier bank details',
  input_descriptors: [
    {
      id: 'FinanceDataOfficer',
      name: 'Finance Data Officer credential',
      constraints: {
        limit_disclosure: 'required',
        fields: [
          { path: ['$.vct'], filter: { type: 'string', enum: [ROLE_CREDENTIAL_VCT] } },
          { path: ['$.role'], filter: { type: 'string', enum: [OFFICER_CREDENTIAL.role] } },
          { path: ['$.org'], filter: { type: 'string' } },
        ],
      },
    },
  ],
}

class AuthorizationServer {
  private readonly pending = new Map<string, PendingAuthorization>()
  private readonly codes = new Map<string, IssuedCode>()

  private signingKey!: CryptoKey
  private publicJwk!: JWK
  private readonly keyId = randomUUID()
  private verifierDid!: string

  public constructor(private readonly identityService: IdentityServiceClient) {}

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
    return {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
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
  }): Promise<{ requestId: string; authorizationRequest: string }> {
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
    return { requestId, authorizationRequest: session.authorizationRequest }
  }

  public getPending(requestId: string): PendingAuthorization | undefined {
    return this.pending.get(requestId)
  }

  /**
   * Complete an authorization once the presentation has been verified.
   *
   * Heka confirms the presentation is sound; whose credential it is, of what type, and whether
   * it is still live is this server's decision (src/shared/presented-credential.ts). Skipping
   * that would make the officer credential's revocation meaningless on this path.
   */
  public async completeAuthorization(requestId: string): Promise<{ code: string; redirectTo: string }> {
    const authorization = this.pending.get(requestId)
    if (!authorization) throw new Error('unknown or expired authorization request')

    const trustedIssuer = loadState().issuerDid
    if (!trustedIssuer) {
      this.pending.delete(requestId)
      throw new Error('no trusted issuer configured — run `yarn seed`')
    }

    // Possibly unset in the catch: a refusal logs the status pointer only when one was read.
    let presented: PresentedCredential | undefined
    let status: StatusCheck
    try {
      presented = readPresentedCredential(
        await this.identityService.getVerificationSession(authorization.verificationSessionId)
      )
      status = await assertPresentedCredentialValid(
        presented,
        {
          trustedIssuers: [trustedIssuer],
          requiredVct: ROLE_CREDENTIAL_VCT,
          statusListOrigin: this.identityService.baseOrigin,
          credentialLabel: OFFICER_CREDENTIAL.role,
          requiredClaims: { role: OFFICER_CREDENTIAL.role },
        },
        fetch
      )
    } catch (error) {
      // "Not yet" is a normal poll result and the request stays open. Any other refusal is a
      // decision: the request is over, so a later poll cannot re-ask and get a different answer.
      if (error instanceof PresentationRefused && error.reason !== 'not-verified') {
        this.pending.delete(requestId)
        if (error.reason === 'revoked' && presented?.credentialStatus) {
          const { statusListIndex, statusListCredential } = presented.credentialStatus
          console.log(`[as] status checked: index ${statusListIndex} on ${statusListCredential} -> revoked`)
        }
        if (error.reason === 'foreign-status-list' && presented?.credentialStatus) {
          const origin = statusListOriginOf(presented.credentialStatus) ?? '(not a URL)'
          console.log(`[as] status list origin ${origin} is not ${this.identityService.baseOrigin}`)
        }
        console.log(`[as] authorization ${requestId.slice(0, 8)} refused (${error.reason}): ${error.message}`)
      }
      throw error
    }

    const { role, org } = presented.claims
    if (typeof role !== 'string' || typeof org !== 'string') {
      this.pending.delete(requestId)
      throw new Error('the presentation did not disclose role and org')
    }
    const claims = { role, org }

    const code = randomUUID()
    this.codes.set(code, { authorization, presented, status, claims })
    this.pending.delete(requestId)

    const redirectTo = new URL(authorization.redirectUri)
    redirectTo.searchParams.set('code', code)
    redirectTo.searchParams.set('iss', ISSUER) // RFC 9207
    if (authorization.state) redirectTo.searchParams.set('state', authorization.state)

    console.log(`[as] authorization ${requestId.slice(0, 8)} granted to ${claims.role}`)
    return { code, redirectTo: redirectTo.toString() }
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
      .setIssuer(ISSUER)
      .setAudience(audience)
      .setSubject(`${claims.role}@${claims.org}`)
      .setIssuedAt()
      .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
      .setJti(randomUUID())
      .sign(this.signingKey)

    console.log(`[as] token issued: scope=${authorization.scope} aud=${audience} ttl=${TOKEN_TTL_SECONDS}s`)
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_SECONDS,
      scope: authorization.scope,
    }
  }
}

async function main() {
  const identityService = identityServiceFromEnv()
  const as = new AuthorizationServer(identityService)
  await as.initialize()

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
    if (!redirect_uri || !resource) {
      res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri and resource are required' })
      return
    }

    try {
      const { requestId, authorizationRequest } = await as.beginAuthorization({
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
        message: `Present a ${OFFICER_CREDENTIAL.role} credential to authorize scope "${scope ?? SUPPLIERS_EXPORT_SCOPE}"`,
      })
    } catch (error) {
      res.status(500).json({ error: 'server_error', error_description: (error as Error).message })
    }
  })

  /** Poll: has the presentation arrived, and may we have the code? */
  app.get('/authorize/:requestId', async (req, res) => {
    if (!as.getPending(req.params.requestId)) {
      res.status(404).json({ error: 'invalid_request', error_description: 'unknown authorization request' })
      return
    }

    try {
      const { code, redirectTo } = await as.completeAuthorization(req.params.requestId)
      res.json({ status: 'granted', code, redirectTo })
    } catch (error) {
      const message = (error as Error).message
      // "not yet" is a normal poll result; a revocation is a decision.
      if (message.includes('no verified presentation yet')) {
        res.json({ status: 'pending' })
        return
      }
      res.status(403).json({ error: 'access_denied', error_description: message })
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

  app.listen(PORT, () => {
    console.log(`[as] Authorization Server on ${ISSUER}`)
    console.log(`[as] token TTL ${TOKEN_TTL_SECONDS}s — a revoked credential stops mattering within minutes`)
  })
}

main().catch((error) => {
  console.error('[as] FATAL', error?.response?.data ?? error?.message ?? error)
  process.exit(1)
})
