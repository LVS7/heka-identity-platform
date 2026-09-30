/**
 * Core types for the Trust Lens verification engine.
 *
 * Catalog / entry shapes follow the ARD "AI Catalog" data model (pinned snapshot in ../../spec).
 * The VC Attestation Profile fields follow §4.4 of the demo design document.
 */

// ---------- AI Catalog (ARD) ----------

export interface AiCatalog {
  specVersion: string
  host?: string
  entries: AiCatalogEntry[]
}

export interface AiCatalogEntry {
  /** URN of form urn:air:<publisher-FQDN>:<namespace>:<name> */
  identifier: string
  displayName: string
  /** IANA media type, e.g. application/a2a-agent-card+json or application/mcp-server-card+json */
  type: string
  url?: string
  data?: unknown
  description?: string
  tags?: string[]
  capabilities?: string[]
  /** ARD: 2–5 sample requests the resource handles well (see spec/ADR-001). */
  representativeQueries?: string[]
  trustManifest?: TrustManifest
}

export interface TrustManifest {
  /** SPIFFE ID | DID | HTTPS URL */
  identity: string
  identityType: 'spiffe' | 'did' | 'https'
  attestations?: Attestation[]
  /** Optional JWS over the manifest */
  signature?: string
}

export interface Attestation {
  /** e.g. application/vc+sd-jwt */
  type: string
  uri: string
  /** e.g. sha256-<base64> over the fetched bytes */
  digest: string
}

// ---------- Resource Passport (SD-JWT VC payload claims) ----------

export const RESOURCE_PASSPORT_VCT = 'urn:heka:resource-passport:v1'
export const ROLE_CREDENTIAL_VCT = 'urn:heka:role-credential:v1'

export interface ResourcePassportClaims {
  vct: typeof RESOURCE_PASSPORT_VCT
  resource_did: string
  resource_name: string
  resource_type: 'a2a-agent' | 'mcp-server'
  resource_card_url: string
  resource_card_digest: string
  operator: {
    legal_name: string
    domain: string
    kyb_ref?: string
  }
  capabilities?: string[]
  /** App-layer status binding (design decision D7): W3C Bitstring Status List pointer */
  credentialStatus?: CredentialStatusClaim
}

export interface CredentialStatusClaim {
  /** Public URL of the BitstringStatusListCredential (Heka: GET /credentials/status/{id}) */
  statusListCredential: string
  statusListIndex: number
}

// ---------- Verdicts ----------

export enum Verdict {
  Verified = 'VERIFIED',
  NoAttestation = 'NO_ATTESTATION',
  UntrustedIssuer = 'UNTRUSTED_ISSUER',
  SubjectMismatch = 'SUBJECT_MISMATCH',
  OperatorDomainMismatch = 'OPERATOR_DOMAIN_MISMATCH',
  DigestMismatch = 'DIGEST_MISMATCH',
  Expired = 'EXPIRED',
  Revoked = 'REVOKED',
  NoStatus = 'NO_STATUS',
}

/** Evidence gathered while verifying a single candidate; attached to the verdict and the audit log. */
export interface VerificationEvidence {
  entryIdentifier: string
  servingDomain?: string
  urnPublisherFqdn?: string
  identity?: string
  didResolved?: boolean
  issuerDid?: string
  issuerTrusted?: boolean
  attestationUri?: string
  digestValid?: boolean
  signatureValid?: boolean
  validityWindowOk?: boolean
  subjectDid?: string
  operatorDomain?: string
  operatorLegalName?: string
  cardDigestValid?: boolean
  statusPointerPresent?: boolean
  statusListChecked?: boolean
  statusRevoked?: boolean
  failureDetail?: string
}

export interface VerificationResult {
  verdict: Verdict
  evidence: VerificationEvidence
  verifiedAt: string
  /**
   * The resource card the digest check accepted, parsed — only with VERIFIED. What a client
   * connects to comes from here: the bytes that were verified, not a second fetch and never the
   * registry.
   */
  card?: unknown
}

// ---------- Audit ----------

export type AuditEventType =
  'verification' | 'authorization' | 'denial' | 'revocation' | 'issuance' | 'engagement_refused'

export interface AuditEvent {
  id: string
  type: AuditEventType
  timestamp: string
  subject: string
  outcome: string
  evidence?: unknown
}
