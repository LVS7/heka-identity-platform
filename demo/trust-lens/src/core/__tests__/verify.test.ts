import { describe, expect, it, vi } from 'vitest'

import { sha256Digest } from '../digest'
import { AiCatalogEntry, RESOURCE_PASSPORT_VCT, Verdict } from '../types'
import { SdJwtVerification, urnPublisherFqdn, verifyEntry, VerifierOptions } from '../verify'

const ACME_DOMAIN = 'acme-invoices.localhost'
const PRO_DOMAIN = 'acme-invoices-ai.localhost'
const TRUSTCO = 'did:hedera:testnet:trustco_0.0.1'
const ACME_AGENT_DID = 'did:hedera:testnet:acmeagent_0.0.2'
const PRO_AGENT_DID = 'did:hedera:testnet:proagent_0.0.3'

const CARD = '{"name":"Acme Invoice Agent"}'
const ATTESTATION = 'eyJhbGciOiJFZERTQSJ9.payload.signature~'
const STATUS_LIST_URL = 'http://localhost:3000/credentials/status/list-1'

/** A status list where only index 7 is revoked. */
const statusListResponse = (revokedIndex?: number) => {
  const bytes = Buffer.alloc(125)
  if (revokedIndex !== undefined) bytes[Math.floor(revokedIndex / 8)] |= 1 << (7 - (revokedIndex % 8))
  const { gzipSync } = require('node:zlib')
  return {
    ok: true,
    json: async () => ({
      credentialSubject: { encodedList: `u${gzipSync(bytes).toString('base64url')}` },
    }),
  }
}

const passportClaims = (overrides: Record<string, unknown> = {}) => ({
  vct: RESOURCE_PASSPORT_VCT,
  iss: TRUSTCO,
  resource_did: ACME_AGENT_DID,
  resource_name: 'Acme Invoice Agent',
  resource_type: 'a2a-agent',
  resource_card_url: `https://${ACME_DOMAIN}/.well-known/agent-card.json`,
  resource_card_digest: sha256Digest(CARD),
  operator: { legal_name: 'Acme Corp GmbH', domain: ACME_DOMAIN },
  credentialStatus: { statusListCredential: STATUS_LIST_URL, statusListIndex: 3 },
  ...overrides,
})

const entry = (overrides: Partial<AiCatalogEntry> = {}): AiCatalogEntry => ({
  identifier: `urn:air:${ACME_DOMAIN}:finance:invoice-agent`,
  displayName: 'Acme Invoice Agent',
  type: 'application/a2a-agent-card+json',
  url: `https://${ACME_DOMAIN}/.well-known/agent-card.json`,
  trustManifest: {
    identity: ACME_AGENT_DID,
    identityType: 'did',
    attestations: [
      { type: 'application/vc+sd-jwt', uri: `https://${ACME_DOMAIN}/.well-known/attestations/p.sd-jwt`, digest: sha256Digest(ATTESTATION) },
    ],
  },
  ...overrides,
})

/** Fetch stub: attestation, card and status list, keyed by URL shape. */
const fetchStub = (opts: { attestation?: string; card?: string; revokedIndex?: number; statusFails?: boolean } = {}) =>
  vi.fn(async (url: string) => {
    if (url.includes('/attestations/')) return { ok: true, text: async () => opts.attestation ?? ATTESTATION }
    if (url.includes('agent-card.json')) return { ok: true, text: async () => opts.card ?? CARD }
    if (url.includes('/credentials/status/')) {
      if (opts.statusFails) return { ok: false, status: 503 }
      return statusListResponse(opts.revokedIndex)
    }
    return { ok: false, status: 404 }
  }) as unknown as typeof fetch

const options = (over: Partial<VerifierOptions> = {}): VerifierOptions => ({
  trustedIssuers: [TRUSTCO],
  resolveDid: async (did: string) => ({ id: did }),
  verifySdJwt: async (): Promise<SdJwtVerification> => ({
    valid: true,
    issuer: TRUSTCO,
    payload: passportClaims() as never,
  }),
  fetchFn: fetchStub(),
  ...over,
})

const acme = { servingDomain: ACME_DOMAIN }

describe('urnPublisherFqdn', () => {
  it('extracts the publisher FQDN from an urn:air identifier', () => {
    expect(urnPublisherFqdn(`urn:air:${ACME_DOMAIN}:finance:invoice-agent`)).toBe(ACME_DOMAIN)
  })

  it('returns undefined for a non-air URN', () => {
    expect(urnPublisherFqdn('urn:other:foo')).toBeUndefined()
  })
})

describe('verifyEntry', () => {
  it('returns VERIFIED when every binding holds', async () => {
    const result = await verifyEntry(entry(), acme, options())

    expect(result.verdict).toBe(Verdict.Verified)
    expect(result.evidence).toMatchObject({
      didResolved: true,
      digestValid: true,
      issuerTrusted: true,
      cardDigestValid: true,
      operatorLegalName: 'Acme Corp GmbH',
      subjectDid: ACME_AGENT_DID,
      statusPointerPresent: true,
      statusListChecked: true,
      statusRevoked: false,
    })
  })

  it('returns SUBJECT_MISMATCH for a genuine credential replayed onto another resource', async () => {
    // The lookalike publisher: spec-valid catalog, real TrustCo credential, own DID in the
    // manifest — but the credential was issued for Acme's agent.
    const proEntry = entry({
      identifier: `urn:air:${PRO_DOMAIN}:finance:invoice-agent`,
      url: `https://${PRO_DOMAIN}/.well-known/agent-card.json`,
      trustManifest: {
        identity: PRO_AGENT_DID,
        identityType: 'did',
        attestations: [
          { type: 'application/vc+sd-jwt', uri: `https://${PRO_DOMAIN}/.well-known/attestations/p.sd-jwt`, digest: sha256Digest(ATTESTATION) },
        ],
      },
    })

    const result = await verifyEntry(proEntry, { servingDomain: PRO_DOMAIN }, options())

    expect(result.verdict).toBe(Verdict.SubjectMismatch)
    // Everything before the subject check passed — that is what makes the lookalike convincing.
    expect(result.evidence).toMatchObject({ didResolved: true, digestValid: true, issuerTrusted: true })
    expect(result.evidence.failureDetail).toContain(PRO_AGENT_DID)
  })

  it('returns NO_ATTESTATION when the entry carries none', async () => {
    const result = await verifyEntry(entry({ trustManifest: undefined }), acme, options())
    expect(result.verdict).toBe(Verdict.NoAttestation)
  })

  it('returns UNTRUSTED_ISSUER for an issuer outside the relying party’s anchors', async () => {
    const result = await verifyEntry(entry(), acme, options({ trustedIssuers: ['did:hedera:testnet:someone-else'] }))

    expect(result.verdict).toBe(Verdict.UntrustedIssuer)
    expect(result.evidence.issuerTrusted).toBe(false)
  })

  it('returns OPERATOR_DOMAIN_MISMATCH when the URN publisher is not the serving domain', async () => {
    const result = await verifyEntry(entry(), { servingDomain: 'evil.example' }, options())

    expect(result.verdict).toBe(Verdict.OperatorDomainMismatch)
    expect(result.evidence.failureDetail).toContain('evil.example')
  })

  it('returns OPERATOR_DOMAIN_MISMATCH when the attested operator domain differs from the publisher', async () => {
    const result = await verifyEntry(
      entry(),
      acme,
      options({
        verifySdJwt: async () => ({
          valid: true,
          issuer: TRUSTCO,
          payload: passportClaims({ operator: { legal_name: 'Acme Corp GmbH', domain: 'somewhere-else.example' } }) as never,
        }),
      })
    )

    expect(result.verdict).toBe(Verdict.OperatorDomainMismatch)
  })

  it('returns DIGEST_MISMATCH when the attestation bytes were swapped after publication', async () => {
    const result = await verifyEntry(entry(), acme, options({ fetchFn: fetchStub({ attestation: 'tampered~' }) }))

    expect(result.verdict).toBe(Verdict.DigestMismatch)
    expect(result.evidence.digestValid).toBe(false)
  })

  it('returns DIGEST_MISMATCH when the resource card was swapped after attestation', async () => {
    const result = await verifyEntry(entry(), acme, options({ fetchFn: fetchStub({ card: '{"name":"Swapped"}' }) }))

    expect(result.verdict).toBe(Verdict.DigestMismatch)
    expect(result.evidence.cardDigestValid).toBe(false)
  })

  it('returns EXPIRED outside the credential validity window', async () => {
    const result = await verifyEntry(
      entry(),
      acme,
      options({ verifySdJwt: async () => ({ valid: false, error: 'credential expired at 2020-01-01' }) })
    )

    expect(result.verdict).toBe(Verdict.Expired)
    expect(result.evidence.validityWindowOk).toBe(false)
  })

  it('returns REVOKED when the issuer has revoked that credential', async () => {
    const result = await verifyEntry(
      entry(),
      acme,
      options({
        fetchFn: fetchStub({ revokedIndex: 7 }),
        verifySdJwt: async () => ({
          valid: true,
          issuer: TRUSTCO,
          payload: passportClaims({
            credentialStatus: { statusListCredential: STATUS_LIST_URL, statusListIndex: 7 },
          }) as never,
        }),
      })
    )

    expect(result.verdict).toBe(Verdict.Revoked)
    expect(result.evidence.statusRevoked).toBe(true)
  })

  it('stays VERIFIED when a different index on the same status list is revoked', async () => {
    const result = await verifyEntry(
      entry(),
      acme,
      options({
        fetchFn: fetchStub({ revokedIndex: 7 }),
        verifySdJwt: async () => ({
          valid: true,
          issuer: TRUSTCO,
          payload: passportClaims({
            credentialStatus: { statusListCredential: STATUS_LIST_URL, statusListIndex: 3 },
          }) as never,
        }),
      })
    )

    expect(result.verdict).toBe(Verdict.Verified)
    expect(result.evidence.statusRevoked).toBe(false)
  })

  it('fails closed to REVOKED when the status list cannot be read', async () => {
    const result = await verifyEntry(
      entry(),
      acme,
      options({
        fetchFn: fetchStub({ statusFails: true }),
        verifySdJwt: async () => ({
          valid: true,
          issuer: TRUSTCO,
          payload: passportClaims({
            credentialStatus: { statusListCredential: STATUS_LIST_URL, statusListIndex: 3 },
          }) as never,
        }),
      })
    )

    expect(result.verdict).toBe(Verdict.Revoked)
    expect(result.evidence.statusListChecked).toBe(false)
  })

  it('returns NO_STATUS when the passport carries no status pointer (it could never be revoked)', async () => {
    const result = await verifyEntry(
      entry(),
      acme,
      options({
        verifySdJwt: async () => ({
          valid: true,
          issuer: TRUSTCO,
          payload: passportClaims({ credentialStatus: undefined }) as never,
        }),
      })
    )

    expect(result.verdict).toBe(Verdict.NoStatus)
    expect(result.evidence.statusPointerPresent).toBe(false)
    expect(result.evidence.statusListChecked).toBeUndefined()
    expect(result.evidence.failureDetail).toMatch(/no status pointer/)
  })

  it('refuses an entry whose identity cannot be resolved', async () => {
    const result = await verifyEntry(
      entry(),
      acme,
      options({
        resolveDid: async () => {
          throw new Error('unknown did method')
        },
      })
    )

    expect(result.verdict).toBe(Verdict.NoAttestation)
    expect(result.evidence.didResolved).toBe(false)
  })
})
