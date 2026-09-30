/**
 * The verification engine — the part of the demo that actually decides trust.
 *
 * Procedure (design §4.4), in order, short-circuiting on the first failure:
 *
 *   1. the URN's publisher FQDN must equal the domain the catalog was served from
 *   2. resolve trustManifest.identity (did:hedera)
 *   3. fetch the attestation, check its digest, verify the SD-JWT signature and validity window
 *   4. the issuer must be one this relying party trusts
 *   5. subject binding: credential.resource_did == trustManifest.identity
 *      operator domain: operator.domain == URN publisher FQDN == serving domain
 *      card binding: resource_card_digest == digest of the served card
 *   6. status list: is this credential revoked right now — and does it have a status pointer at all
 *
 * Two properties this deliberately has:
 *
 * - It runs in the orchestrator, never the registry. ARD §7.2 assigns trust evaluation to the
 *   consuming orchestrator, and relying parties pick their own trust anchors.
 * - Nothing here trusts registry-held data. Every input is re-fetched from the publisher, so a
 *   compromised or careless registry cannot influence a verdict.
 *
 * External capabilities (DID resolution, SD-JWT verification, HTTP) are injected so the whole
 * decision table is unit-testable without a network.
 */

import { verifyDigest } from './digest'
import { checkCredentialStatus } from './status-list'
import {
  AiCatalogEntry,
  CredentialStatusClaim,
  ResourcePassportClaims,
  Verdict,
  VerificationEvidence,
  VerificationResult,
} from './types'

export interface SdJwtVerification {
  valid: boolean
  /** Issuer DID taken from the credential's `iss` claim. */
  issuer?: string
  payload?: Partial<ResourcePassportClaims> & { iss?: string; exp?: number; nbf?: number }
  error?: string
}

export interface VerifierDependencies {
  /** Resolve a DID; reject/throw when it cannot be resolved. */
  resolveDid(did: string): Promise<{ id: string }>
  /** Verify an SD-JWT VC's issuer signature and validity window. */
  verifySdJwt(compact: string): Promise<SdJwtVerification>
  fetchFn?: typeof fetch
}

export interface VerifierOptions extends VerifierDependencies {
  /** DIDs whose attestations this relying party accepts (the demo anchor is TrustCo). */
  trustedIssuers: string[]
}

export interface VerifyContext {
  /** The domain the catalog was actually served from. */
  servingDomain: string
}

/** Extract the publisher FQDN from an ARD identifier URN (urn:air:<fqdn>:<ns>:<name>). */
export function urnPublisherFqdn(identifier: string): string | undefined {
  return /^urn:air:([^:]+):/.exec(identifier)?.[1]
}

const decided = (verdict: Verdict, evidence: VerificationEvidence, failureDetail?: string): VerificationResult => ({
  verdict,
  evidence: failureDetail ? { ...evidence, failureDetail } : evidence,
  verifiedAt: new Date().toISOString(),
})

export async function verifyEntry(
  entry: AiCatalogEntry,
  context: VerifyContext,
  options: VerifierOptions
): Promise<VerificationResult> {
  const fetchFn = options.fetchFn ?? fetch
  const publisherFqdn = urnPublisherFqdn(entry.identifier)

  const evidence: VerificationEvidence = {
    entryIdentifier: entry.identifier,
    servingDomain: context.servingDomain,
    urnPublisherFqdn: publisherFqdn,
  }

  // 1. The URN is domain-anchored; the publisher it names must be the host that served it.
  if (!publisherFqdn || publisherFqdn.toLowerCase() !== context.servingDomain.toLowerCase()) {
    return decided(
      Verdict.OperatorDomainMismatch,
      evidence,
      `URN publisher "${publisherFqdn ?? '(none)'}" does not match serving domain "${context.servingDomain}"`
    )
  }

  const attestation = entry.trustManifest?.attestations?.[0]
  if (!entry.trustManifest || !attestation) {
    return decided(Verdict.NoAttestation, evidence, 'entry carries no attestation to verify')
  }

  evidence.identity = entry.trustManifest.identity
  evidence.attestationUri = attestation.uri

  // 2. The identity must resolve. A DID nobody can resolve vouches for nothing.
  try {
    await options.resolveDid(entry.trustManifest.identity)
    evidence.didResolved = true
  } catch (error) {
    evidence.didResolved = false
    return decided(Verdict.NoAttestation, evidence, `could not resolve ${entry.trustManifest.identity}: ${message(error)}`)
  }

  // 3. Fetch the attestation and bind it to the catalog by digest before trusting its content.
  let compact: string
  try {
    const response = await fetchFn(attestation.uri)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    compact = (await response.text()).trim()
  } catch (error) {
    return decided(Verdict.NoAttestation, evidence, `could not fetch attestation: ${message(error)}`)
  }

  evidence.digestValid = attestation.digest ? verifyDigest(compact, attestation.digest) : undefined
  if (evidence.digestValid === false) {
    return decided(Verdict.DigestMismatch, evidence, 'attestation bytes do not match the digest pinned in the catalog')
  }

  const verification = await options.verifySdJwt(compact)
  evidence.signatureValid = verification.valid

  if (!verification.valid || !verification.payload) {
    const detail = verification.error ?? 'signature verification failed'
    // An expired credential is a distinct, meaningful outcome for the operator.
    return /expired|exp|validity/i.test(detail)
      ? decided(Verdict.Expired, { ...evidence, validityWindowOk: false }, detail)
      : decided(Verdict.NoAttestation, evidence, detail)
  }

  const claims = verification.payload
  const issuer = verification.issuer ?? claims.iss
  evidence.issuerDid = issuer
  evidence.validityWindowOk = true

  // 4. Trust anchors are the relying party's choice, not the registry's.
  evidence.issuerTrusted = Boolean(issuer && options.trustedIssuers.includes(issuer))
  if (!evidence.issuerTrusted) {
    return decided(Verdict.UntrustedIssuer, evidence, `issuer "${issuer ?? '(none)'}" is not a trusted anchor`)
  }

  // 5a. Subject binding — this is what catches a genuine credential replayed onto another resource.
  evidence.subjectDid = claims.resource_did
  if (claims.resource_did !== entry.trustManifest.identity) {
    return decided(
      Verdict.SubjectMismatch,
      evidence,
      `credential subject ${claims.resource_did} is not the manifest identity ${entry.trustManifest.identity}`
    )
  }

  // 5b. Operator domain — how did:hedera satisfies ARD's domain-alignment rule (see spec/ADR-001).
  evidence.operatorDomain = claims.operator?.domain
  evidence.operatorLegalName = claims.operator?.legal_name
  if (!claims.operator?.domain || claims.operator.domain.toLowerCase() !== publisherFqdn.toLowerCase()) {
    return decided(
      Verdict.OperatorDomainMismatch,
      evidence,
      `attested operator domain "${claims.operator?.domain ?? '(none)'}" does not match publisher "${publisherFqdn}"`
    )
  }

  // 5c. Card binding — prevents swapping the card after it was attested.
  if (claims.resource_card_digest && entry.url) {
    try {
      const response = await fetchFn(entry.url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const card = await response.text()
      evidence.cardDigestValid = verifyDigest(card, claims.resource_card_digest)
    } catch (error) {
      evidence.cardDigestValid = false
      return decided(Verdict.DigestMismatch, evidence, `could not fetch the resource card: ${message(error)}`)
    }

    if (!evidence.cardDigestValid) {
      return decided(Verdict.DigestMismatch, evidence, 'resource card does not match the digest in its passport')
    }
  }

  // 6. Revocation is live state, so it is checked last and never cached.
  const status = claims.credentialStatus as CredentialStatusClaim | undefined
  evidence.statusPointerPresent = Boolean(status)
  if (!status) {
    // A credential nobody can revoke is not one this relying party will rely on.
    return decided(Verdict.NoStatus, evidence, 'passport carries no status pointer and can never be revoked')
  }

  try {
    evidence.statusRevoked = await checkCredentialStatus(status, fetchFn)
    evidence.statusListChecked = true
  } catch (error) {
    // Fail closed: an unreadable status list means we cannot claim the credential is live.
    evidence.statusListChecked = false
    return decided(Verdict.Revoked, evidence, `status list unavailable, refusing to assume valid: ${message(error)}`)
  }

  if (evidence.statusRevoked) {
    return decided(Verdict.Revoked, evidence, 'credential is revoked by its issuer')
  }

  return decided(Verdict.Verified, evidence)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
