import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

import { describe, expect, it, vi } from 'vitest'

import { ROLE_CREDENTIAL_VCT } from '../../core/types'
import { VerificationSessionRecord } from '../identity-service'
import {
  assertPresentedCredentialValid,
  evaluateOfficerPresentation,
  PresentationPolicy,
  PresentationRefused,
  readPresentedCredential,
} from '../presented-credential'

const TRUSTCO = 'did:hedera:testnet:trustco_0.0.1'
const STATUS_LIST_URL = 'http://localhost:3000/credentials/status/list-1'

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const digest = (disclosure: string) => createHash('sha256').update(disclosure, 'ascii').digest('base64url')

/** Build a compact SD-JWT presentation the way an issuer + holder would, minus the signatures. */
function token(
  overrides: Record<string, unknown> = {},
  disclosed: Record<string, unknown> = { role: 'Finance Data Officer', org: 'TrustCo' }
) {
  const disclosures = Object.entries(disclosed).map(([name, value]) => b64([`salt-${name}`, name, value]))
  const payload = {
    vct: ROLE_CREDENTIAL_VCT,
    iss: TRUSTCO,
    cnf: { kid: 'did:key:z6MkHolder#key-1' },
    credentialStatus: { statusListCredential: STATUS_LIST_URL, statusListIndex: 3 },
    _sd_alg: 'sha-256',
    _sd: disclosures.map(digest),
    ...overrides,
  }
  const issuerJwt = `${b64({ alg: 'EdDSA' })}.${b64(payload)}.sig`
  const kbJwt = `${b64({ typ: 'kb+jwt' })}.${b64({ aud: 'did:key:verifier', sd_hash: 'x' })}.sig`
  return `${issuerJwt}~${disclosures.join('~')}~${kbJwt}`
}

const session = (
  over: Partial<VerificationSessionRecord> = {},
  vpToken: unknown = token()
): VerificationSessionRecord => ({
  id: 'session-1',
  state: 'ResponseVerified',
  sharedAttributes: { role: 'ignored', org: 'ignored' },
  authorizationResponsePayload: { vp_token: vpToken, presentation_submission: {} },
  ...over,
})

const policy = (over: Partial<PresentationPolicy> = {}): PresentationPolicy => ({
  trustedIssuers: [TRUSTCO],
  requiredVct: ROLE_CREDENTIAL_VCT,
  statusListOrigin: 'http://localhost:3000',
  credentialLabel: 'Finance Data Officer',
  requiredClaims: { role: 'Finance Data Officer' },
  ...over,
})

/** A status list response where only `revokedIndex` is set. */
const statusList = (revokedIndex?: number) => {
  const bytes = Buffer.alloc(125)
  if (revokedIndex !== undefined) bytes[Math.floor(revokedIndex / 8)] |= 1 << (7 - (revokedIndex % 8))
  return {
    ok: true,
    json: async () => ({ credentialSubject: { encodedList: `u${gzipSync(bytes).toString('base64url')}` } }),
  }
}
const fetchStub = (revokedIndex?: number) => vi.fn(async () => statusList(revokedIndex)) as unknown as typeof fetch

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as PresentationRefused
  }
  throw new Error('expected a refusal')
}

describe('readPresentedCredential', () => {
  it('reads issuer, type, holder, claims and the status pointer from the vp_token, not from sharedAttributes', () => {
    const presented = readPresentedCredential(session())

    expect(presented).toMatchObject({
      sessionId: 'session-1',
      vct: ROLE_CREDENTIAL_VCT,
      issuer: TRUSTCO,
      holder: 'did:key:z6MkHolder#key-1',
      credentialStatus: { statusListCredential: STATUS_LIST_URL, statusListIndex: 3 },
    })
    expect(presented.claims.role).toBe('Finance Data Officer')
    expect(presented.vpToken).toBe(token())
    expect(presented.verifiedAt).toMatch(/^\d{4}-/)
  })

  it('accepts a vp_token given as an array', () => {
    expect(readPresentedCredential(session({}, [token()])).issuer).toBe(TRUSTCO)
  })

  it('refuses a session that is not verified', async () => {
    const error = await refusal(
      Promise.resolve().then(() => readPresentedCredential(session({ state: 'RequestUriRetrieved' })))
    )
    expect(error).toBeInstanceOf(PresentationRefused)
    expect(error.reason).toBe('not-verified')
    expect(error.message).toBe('no verified presentation yet (session is RequestUriRetrieved)')
  })

  it('refuses a verified session without a vp_token as malformed', async () => {
    const error = await refusal(
      Promise.resolve().then(() => readPresentedCredential(session({ authorizationResponsePayload: {} })))
    )
    expect(error).toBeInstanceOf(PresentationRefused)
    expect(error.reason).toBe('malformed')
    expect(error.message).toBe('presentation could not be decoded: vp_token is missing')
  })

  it('refuses a vp_token array that does not hold exactly one presentation', async () => {
    const error = await refusal(Promise.resolve().then(() => readPresentedCredential(session({}, [token(), token()]))))
    expect(error).toBeInstanceOf(PresentationRefused)
    expect(error.reason).toBe('malformed')
    expect(error.message).toBe('presentation could not be decoded: expected exactly one presentation, got 2')
  })

  it('refuses a vp_token that cannot be decoded, rather than throwing a plain error', async () => {
    const error = await refusal(Promise.resolve().then(() => readPresentedCredential(session({}, 'eyJ.eyJ.sig'))))
    expect(error).toBeInstanceOf(PresentationRefused)
    expect(error.reason).toBe('malformed')
    expect(error.message).toMatch(/^presentation could not be decoded: /)
  })
})

describe('assertPresentedCredentialValid', () => {
  it('returns the status check for a live credential from the trusted issuer', async () => {
    const check = await assertPresentedCredentialValid(readPresentedCredential(session()), policy(), fetchStub())

    expect(check).toMatchObject({ statusListCredential: STATUS_LIST_URL, statusListIndex: 3, revoked: false })
    expect(check.checkedAt).toMatch(/^\d{4}-/)
  })

  it('refuses a revoked credential with the message the demo shows', async () => {
    const error = await refusal(
      assertPresentedCredentialValid(readPresentedCredential(session()), policy(), fetchStub(3))
    )
    expect(error.reason).toBe('revoked')
    expect(error.message).toBe('the Finance Data Officer credential has been revoked by its issuer')
  })

  it('refuses an unreadable status list (fail closed)', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch
    const error = await refusal(assertPresentedCredentialValid(readPresentedCredential(session()), policy(), fetchFn))
    expect(error.reason).toBe('status-unavailable')
    expect(error.message).toMatch(/^status list unavailable, refusing to assume valid: /)
  })

  it('does not repeat the "status list unavailable" prefix when the list cannot be reached', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof fetch
    const error = await refusal(assertPresentedCredentialValid(readPresentedCredential(session()), policy(), fetchFn))
    expect(error.reason).toBe('status-unavailable')
    expect(error.message).toBe(
      `status list unavailable, refusing to assume valid: connect ECONNREFUSED for ${STATUS_LIST_URL}`
    )
  })

  it('refuses an issuer this relying party does not trust', async () => {
    const fetchFn = fetchStub()
    const presented = readPresentedCredential(session({}, token({ iss: 'did:hedera:testnet:someone_0.0.9' })))
    const error = await refusal(assertPresentedCredentialValid(presented, policy(), fetchFn))
    expect(error.reason).toBe('untrusted-issuer')
    expect(error.message).toBe(
      'credential issued by did:hedera:testnet:someone_0.0.9, which this relying party does not trust'
    )
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('refuses a credential without a status pointer', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch
    const presented = readPresentedCredential(session({}, token({ credentialStatus: undefined })))
    const error = await refusal(assertPresentedCredentialValid(presented, policy(), fetchFn))
    expect(error.reason).toBe('no-status')
    expect(error.message).toBe('credential carries no status pointer and cannot be revoked')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('refuses a status pointer outside the issuer service', async () => {
    const fetchFn = fetchStub()
    const presented = readPresentedCredential(
      session({}, token({ credentialStatus: { statusListCredential: 'http://evil.example/list', statusListIndex: 3 } }))
    )
    const error = await refusal(assertPresentedCredentialValid(presented, policy(), fetchFn))
    expect(error.reason).toBe('foreign-status-list')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('refuses a status pointer that is not a URL as foreign, without fetching', async () => {
    const fetchFn = fetchStub()
    const presented = readPresentedCredential(
      session({}, token({ credentialStatus: { statusListCredential: 'not a url', statusListIndex: 3 } }))
    )
    const error = await refusal(assertPresentedCredentialValid(presented, policy(), fetchFn))
    expect(error.reason).toBe('foreign-status-list')
    expect(error.message).toBe("credential points at a status list outside the issuer's service")
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('refuses a credential whose disclosed role is not the required one', async () => {
    const fetchFn = fetchStub()
    const presented = readPresentedCredential(session({}, token({}, { role: 'Warehouse Clerk', org: 'TrustCo' })))
    const error = await refusal(assertPresentedCredentialValid(presented, policy(), fetchFn))
    expect(error).toBeInstanceOf(PresentationRefused)
    expect(error.reason).toBe('wrong-role')
    expect(error.message).toBe('credential claim "role" is "Warehouse Clerk", expected "Finance Data Officer"')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('refuses a credential of the wrong type', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch
    const presented = readPresentedCredential(session({}, token({ vct: 'urn:heka:resource-passport:v1' })))
    const error = await refusal(assertPresentedCredentialValid(presented, policy(), fetchFn))
    expect(error.reason).toBe('wrong-type')
    expect(error.message).toBe(`credential is not a ${ROLE_CREDENTIAL_VCT}`)
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('evaluateOfficerPresentation', () => {
  const deps = (over: Partial<Parameters<typeof evaluateOfficerPresentation>[1]> = {}) => ({
    trustedIssuer: TRUSTCO,
    statusListOrigin: 'http://localhost:3000',
    fetchFn: fetchStub(),
    log: () => undefined,
    ...over,
  })

  it('returns what was presented and the live status check', async () => {
    const { presented, status } = await evaluateOfficerPresentation(session(), deps())
    expect(presented.claims.role).toBe('Finance Data Officer')
    expect(status).toMatchObject({ statusListIndex: 3, revoked: false })
  })

  it('refuses when no trusted issuer is configured, without reading the presentation', async () => {
    const error = await refusal(evaluateOfficerPresentation(session(), deps({ trustedIssuer: undefined })))
    expect(error.reason).toBe('untrusted-issuer')
    expect(error.presented).toBeUndefined()
  })

  it('logs the status pointer a revoked credential was judged on, and attaches what was presented', async () => {
    const lines: string[] = []
    const error = await refusal(
      evaluateOfficerPresentation(session(), deps({ fetchFn: fetchStub(3), log: (line) => lines.push(line) }))
    )
    expect(error.reason).toBe('revoked')
    expect(error.presented?.issuer).toBe(TRUSTCO)
    expect(lines.join(' ')).toMatch(/index 3 on .* -> revoked/)
  })
})

describe('against a real presentation', () => {
  /** Captured from the live Identity Service by `yarn capture:presentation`; the decoder tests use the same file. */
  const FIXTURE = readFileSync(
    resolve(__dirname, '../../core/__tests__/fixtures/officer-presentation.sd-jwt'),
    'utf8'
  ).trim()

  it('accepts the captured officer presentation against an all-clear status list', async () => {
    const presented = readPresentedCredential(session({}, FIXTURE))
    const fetchFn = fetchStub()

    const check = await assertPresentedCredentialValid(
      presented,
      {
        trustedIssuers: [presented.issuer],
        requiredVct: ROLE_CREDENTIAL_VCT,
        statusListOrigin: 'http://localhost:3000',
        credentialLabel: 'Finance Data Officer',
        requiredClaims: { role: 'Finance Data Officer' },
      },
      fetchFn
    )

    expect(check).toMatchObject({ statusListIndex: 3, revoked: false })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
