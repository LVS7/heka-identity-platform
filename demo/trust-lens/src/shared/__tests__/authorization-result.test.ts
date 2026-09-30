import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { ROLE_CREDENTIAL_VCT } from '../../core/types'
import { authorizedResult, deniedResult, requestedFromDefinition } from '../authorization-result'
import { PresentedCredential } from '../presented-credential'

const TRUSTCO = 'did:hedera:testnet:trustco_0.0.1'
const HOLDER = 'did:key:z6MkHolder#key-1'
const STATUS_LIST_URL = 'http://localhost:3000/credentials/status/list-1'

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const digest = (disclosure: string) => createHash('sha256').update(disclosure, 'ascii').digest('base64url')

/** What readPresentedCredential returns for the officer credential, with a real compact token. */
function presentedOfficer(): PresentedCredential {
  const disclosures = [b64(['salt-role', 'role', 'Finance Data Officer']), b64(['salt-org', 'org', 'TrustCo'])]
  const credentialStatus = { statusListCredential: STATUS_LIST_URL, statusListIndex: 3 }
  const payload = {
    vct: ROLE_CREDENTIAL_VCT,
    iss: TRUSTCO,
    cnf: { kid: HOLDER },
    credentialStatus,
    _sd_alg: 'sha-256',
    _sd: disclosures.map(digest),
  }
  const issuerJwt = `${b64({ alg: 'EdDSA' })}.${b64(payload)}.sig`
  const kbJwt = `${b64({ typ: 'kb+jwt' })}.${b64({ aud: 'did:key:verifier' })}.sig`
  return {
    sessionId: 'session-1',
    vct: ROLE_CREDENTIAL_VCT,
    issuer: TRUSTCO,
    holder: HOLDER,
    claims: { ...payload, role: 'Finance Data Officer', org: 'TrustCo' },
    credentialStatus,
    vpToken: `${issuerJwt}~${disclosures.join('~')}~${kbJwt}`,
    verifiedAt: '2026-09-28T10:00:00.000Z',
  }
}

const LIVE = {
  statusListCredential: STATUS_LIST_URL,
  statusListIndex: 3,
  revoked: false,
  checkedAt: '2026-09-28T10:00:01.000Z',
}

describe('requestedFromDefinition', () => {
  it('names the type from the vct enum and every other path as a claim', () => {
    const requested = requestedFromDefinition({
      purpose: 'Authorize preparation of a supplier payment export',
      input_descriptors: [
        {
          constraints: {
            fields: [
              { path: ['$.vct'], filter: { type: 'string', enum: [ROLE_CREDENTIAL_VCT] } },
              { path: ['$.role'], filter: { type: 'string', enum: ['Finance Data Officer'] } },
              { path: ['$.org'], filter: { type: 'string' } },
            ],
          },
        },
      ],
    })

    expect(requested).toEqual({
      purpose: 'Authorize preparation of a supplier payment export',
      credentialType: ROLE_CREDENTIAL_VCT,
      claims: ['role', 'org'],
    })
  })
})

describe('authorizedResult', () => {
  it('carries the disclosed claims only, plus issuer, holder, type, status and the token', () => {
    const result = authorizedResult(presentedOfficer(), LIVE)

    expect(result).toMatchObject({
      sessionId: 'session-1',
      outcome: 'authorized',
      claims: { role: 'Finance Data Officer', org: 'TrustCo' },
      issuer: TRUSTCO,
      holder: HOLDER,
      credentialType: ROLE_CREDENTIAL_VCT,
      status: LIVE,
      verifiedAt: '2026-09-28T10:00:00.000Z',
    })
    expect(Object.keys(result.claims ?? {})).toEqual(['role', 'org'])
    expect(result.vpToken?.startsWith('ey')).toBe(true)
  })
})

describe('deniedResult', () => {
  it('is only the reason when nothing was presented', () => {
    expect(deniedResult('session-1', 'no presentation was received in time')).toEqual({
      sessionId: 'session-1',
      outcome: 'denied',
      reason: 'no presentation was received in time',
    })
  })

  it('keeps whose credential was refused and the failed status check, never the claims', () => {
    const reason = 'the Finance Data Officer credential has been revoked by its issuer'
    const result = deniedResult('session-1', reason, presentedOfficer(), 'revoked')

    expect(result.claims).toBeUndefined()
    expect(result).toMatchObject({ outcome: 'denied', reason, issuer: TRUSTCO, holder: HOLDER })
    expect(result.status).toMatchObject({ statusListIndex: 3, revoked: true })
    expect(result.vpToken).toBeTruthy()
  })

  it('reports no status check for a refusal that never read the list', () => {
    const result = deniedResult(
      'session-1',
      'credential issued by x, which this relying party does not trust',
      presentedOfficer(),
      'untrusted-issuer'
    )
    expect(result.status).toBeUndefined()
    expect(result.issuer).toBe(TRUSTCO)
  })
})
