/**
 * Typed client for the Heka Identity Service REST API.
 *
 * Only the endpoints this demo needs. All shapes below were verified against a running
 * instance (see spec/ADR-001) — notably that credential payloads are arbitrary objects,
 * which is what lets us carry our own `credentialStatus` claim (design decision D7).
 */

import axios, { AxiosInstance } from 'axios'

import { BitstringStatusListCredential } from '../core/status-list'

export interface DidDocument {
  id: string
  verificationMethod?: Array<{ id: string; type: string; publicKeyMultibase?: string }>
  [key: string]: unknown
}

export interface SdJwtCredentialConfig {
  format: 'vc+sd-jwt'
  id: string
  vct: string
}

export interface IssuanceOfferCredential {
  format: 'vc+sd-jwt'
  credentialSupportedId: string
  issuer: { method: 'did'; did: string }
  payload: Record<string, unknown>
  disclosureFrame: { _sd: string[] }
}

export interface IssuanceOfferResponse {
  issuanceSession: { id?: string; preAuthorizedCode?: string; state?: string; [key: string]: unknown }
  credentialOffer: string
}

export interface VerificationSessionResponse {
  verificationSession: { id: string; state: string; [key: string]: unknown }
  /** e.g. openid4vp://?client_id=...&request_uri=... */
  authorizationRequest: string
  authorizationRequestObject?: unknown
}

export interface VerificationSessionRecord {
  id: string
  state: string
  sharedAttributes?: Record<string, unknown>
  authorizationResponsePayload?: {
    vp_token?: unknown
    presentation_submission?: unknown
    [key: string]: unknown
  }
}

export class IdentityServiceClient {
  private readonly api: AxiosInstance

  public constructor(
    private readonly baseUrl: string,
    accessToken: string
  ) {
    this.api = axios.create({
      baseURL: baseUrl,
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 120_000,
    })
  }

  // ---------- DIDs ----------

  /** Create a public DID. `hedera` anchors it on the Hedera network (see docs/hedera.md). */
  public async createDid(method: 'hedera' | 'key' | 'indy'): Promise<DidDocument> {
    const { data } = await this.api.post<DidDocument>('/dids', { method })
    return data
  }

  /** Provisions public DIDs for all enabled methods plus issuer/verifier records. Returns a did:key. */
  public async prepareWallet(): Promise<string> {
    const { data } = await this.api.post<{ did: string }>('/prepare-wallet')
    return data.did
  }

  // ---------- OID4VC issuance ----------

  public async createIssuer(publicIssuerId: string, credentialsSupported: SdJwtCredentialConfig[]) {
    const { data } = await this.api.post('/openid4vc/issuer', { publicIssuerId, credentialsSupported })
    return data as { id: string; publicIssuerId: string }
  }

  public async findIssuer(publicIssuerId: string) {
    const { data } = await this.api.get('/openid4vc/issuer', { params: { publicIssuerId } })
    return data as { id: string; publicIssuerId: string } | null
  }

  public async createIssuanceOffer(
    publicIssuerId: string,
    credentials: IssuanceOfferCredential[]
  ): Promise<IssuanceOfferResponse> {
    const { data } = await this.api.post<IssuanceOfferResponse>('/openid4vc/issuance-session/offer', {
      publicIssuerId,
      credentials,
    })
    return data
  }

  // ---------- OID4VP verification ----------

  public async createVerificationSession(body: {
    publicVerifierId: string
    requestSigner: { method: 'did'; did: string }
    presentationExchange?: { definition: unknown }
    dcql?: unknown
    responseMode?: string
  }): Promise<VerificationSessionResponse> {
    const { data } = await this.api.post<VerificationSessionResponse>('/openid4vc/verification-session/request', body)
    return data
  }

  /**
   * The record Heka keeps for a verification session. After `ResponseVerified` it also carries the
   * parsed authorization response — the `vp_token` is what a relying party evaluates, because
   * `sharedAttributes` strips `iss` and `cnf` and this demo needs both.
   */
  public async getVerificationSession(id: string): Promise<VerificationSessionRecord> {
    const { data } = await this.api.get<VerificationSessionRecord>(`/openid4vc/verification-session/${id}`)
    return data
  }

  /** Origin of the Identity Service — the only place this issuer's status lists may live. */
  public get baseOrigin(): string {
    return new URL(this.baseUrl).origin
  }

  // ---------- Bitstring status lists (revocation, D7) ----------

  public async createStatusList(issuer: string, size = 1000, purpose = 'revocation'): Promise<string> {
    const { data } = await this.api.post<{ id: string }>('/status-lists', { issuer, size, purpose })
    return data.id
  }

  public async setRevoked(statusListId: string, indexes: number[], revoked: boolean): Promise<void> {
    await this.api.put(`/status-lists/${statusListId}`, { indexes, revoked })
  }

  /** Public URL of a status list credential — this is what goes into a credentialStatus claim. */
  public statusListUrl(statusListId: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}/credentials/status/${statusListId}`
  }

  /** Public (unauthenticated) read of the status list credential. */
  public async fetchStatusList(statusListId: string): Promise<BitstringStatusListCredential> {
    const { data } = await axios.get<BitstringStatusListCredential>(this.statusListUrl(statusListId), {
      timeout: 30_000,
    })
    return data
  }

  /** WebSocket URL for issuance/verification notifications. */
  public notificationsUrl(): string {
    return `${this.baseUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/notifications`
  }
}

export function identityServiceFromEnv(): IdentityServiceClient {
  const url = process.env.IDENTITY_SERVICE_URL
  const token = process.env.IDENTITY_SERVICE_ACCESS_TOKEN
  if (!url || !token) {
    throw new Error('IDENTITY_SERVICE_URL and IDENTITY_SERVICE_ACCESS_TOKEN must be set (see .env.example)')
  }
  return new IdentityServiceClient(url, token)
}
