import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { decodeSdJwtPresentation, holderBindingOf } from '../sd-jwt'

/** A real presentation, captured from the live Identity Service by `yarn capture:presentation`. */
const FIXTURE = readFileSync(resolve(__dirname, 'fixtures/officer-presentation.sd-jwt'), 'utf8').trim()

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const digest = (disclosure: string) => createHash('sha256').update(disclosure, 'ascii').digest('base64url')
const jwt = (payload: unknown) => `${b64({ alg: 'EdDSA' })}.${b64(payload)}.signature`

describe('decodeSdJwtPresentation', () => {
  it('decodes the issuer JWT, the disclosures and the key binding of a real presentation', () => {
    const decoded = decodeSdJwtPresentation(FIXTURE)

    expect(decoded.issuerJwt.payload.vct).toBe('urn:heka:role-credential:v1')
    expect(String(decoded.issuerJwt.payload.iss)).toMatch(/^did:hedera:/)
    expect(decoded.disclosures.map((d) => d.name).sort()).toEqual(['org', 'role'])
    expect(decoded.keyBinding?.payload).toHaveProperty('sd_hash')
  })

  it('places disclosed claims at their _sd slots and drops the digests', () => {
    const { claims } = decodeSdJwtPresentation(FIXTURE)

    expect(claims.role).toBe('Finance Data Officer')
    expect(claims.org).toBe('TrustCo Certification GmbH')
    expect(claims).not.toHaveProperty('_sd')
    expect(claims).not.toHaveProperty('_sd_alg')
    expect(claims.credentialStatus).toMatchObject({ statusListIndex: 3 })
  })

  it('resolves nested _sd slots and ignores decoy digests', () => {
    const disclosure = b64(['salt-1', 'role', 'Auditor'])
    const token = `${jwt({ _sd_alg: 'sha-256', operator: { _sd: [digest(disclosure), 'decoy-digest'] } })}~${disclosure}~`

    expect(decodeSdJwtPresentation(token).claims).toEqual({ operator: { role: 'Auditor' } })
  })

  it('tolerates a presentation without a key-binding JWT', () => {
    const token = `${jwt({ vct: 'x' })}~`
    expect(decodeSdJwtPresentation(token).keyBinding).toBeUndefined()
  })

  it('rejects input without a "~" separator', () => {
    expect(() => decodeSdJwtPresentation(jwt({}))).toThrow(/no "~"/)
  })

  it('rejects array disclosures as unsupported', () => {
    const token = `${jwt({ items: [{ '...': 'digest' }] })}~`
    expect(() => decodeSdJwtPresentation(token)).toThrow(/array disclosures/)
  })

  it('rejects a disclosure that is not base64url JSON', () => {
    expect(() => decodeSdJwtPresentation(`${jwt({})}~not-json~`)).toThrow(/malformed disclosure/)
  })

  it('ignores a disclosure whose digest the issuer did not sign into _sd', () => {
    // A holder can append any disclosure; only the issuer's _sd digests decide which ones count.
    const signed = b64(['salt-1', 'role', 'Warehouse Clerk'])
    const smuggled = b64(['salt-2', 'clearance', 'top-secret'])
    const token = `${jwt({ _sd_alg: 'sha-256', _sd: [digest(signed)] })}~${signed}~${smuggled}~`

    expect(decodeSdJwtPresentation(token).claims).toEqual({ role: 'Warehouse Clerk' })
  })

  it('rejects a disclosure whose name collides with a plain claim', () => {
    const disclosure = b64(['salt-1', 'role', 'Finance Data Officer'])
    const token = `${jwt({ role: 'Warehouse Clerk', _sd: [digest(disclosure)] })}~${disclosure}~`

    expect(() => decodeSdJwtPresentation(token)).toThrow('malformed disclosure: duplicate claim name "role"')
  })

  it('rejects two disclosures with the same name', () => {
    const first = b64(['salt-1', 'role', 'Warehouse Clerk'])
    const second = b64(['salt-2', 'role', 'Finance Data Officer'])
    const token = `${jwt({ _sd: [digest(first), digest(second)] })}~${first}~${second}~`

    expect(() => decodeSdJwtPresentation(token)).toThrow('malformed disclosure: duplicate claim name "role"')
  })

  it('rejects a disclosure named _sd or ...', () => {
    for (const name of ['_sd', '...']) {
      const disclosure = b64(['salt-1', name, ['x']])
      const token = `${jwt({ _sd: [digest(disclosure)] })}~${disclosure}~`

      expect(() => decodeSdJwtPresentation(token)).toThrow('malformed disclosure: reserved claim name')
    }
  })
})

describe('holderBindingOf', () => {
  it('reports the holder binding of a real presentation', () => {
    expect(holderBindingOf(decodeSdJwtPresentation(FIXTURE))).toMatch(
      /^did:key:|^urn:ietf:params:oauth:jwk-thumbprint:sha-256:/
    )
  })

  it('prefers cnf.kid and falls back to the RFC 7638 thumbprint of cnf.jwk', () => {
    expect(holderBindingOf(decodeSdJwtPresentation(`${jwt({ cnf: { kid: 'did:key:z6Mk…#key' } })}~`))).toBe(
      'did:key:z6Mk…#key'
    )
    const jwk = { kty: 'OKP', crv: 'Ed25519', x: 'abc' }
    const expected = createHash('sha256')
      .update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: 'abc' }))
      .digest('base64url')
    expect(holderBindingOf(decodeSdJwtPresentation(`${jwt({ cnf: { jwk } })}~`))).toBe(
      `urn:ietf:params:oauth:jwk-thumbprint:sha-256:${expected}`
    )
  })

  it('is undefined without cnf', () => {
    expect(holderBindingOf(decodeSdJwtPresentation(`${jwt({})}~`))).toBeUndefined()
  })
})
