/**
 * A minimal SD-JWT presentation decoder for display and policy — no cryptography.
 *
 * By the time a relying party in this demo sees a vp_token, Heka has verified the issuer
 * signature and the key binding. What the relying party still needs is what the token *says*:
 * the issuer, the holder binding, the disclosed claims and the status pointer. Heka's
 * `sharedAttributes` strips `iss` and `cnf`, so the compact token is decoded here instead.
 * Digests are recomputed (SHA-256, the SD-JWT default) only to place each disclosure at its
 * `_sd` slot; nothing here decides whether a signature is valid.
 *
 * Scope: flat and nested-object `_sd` arrays. Array-element disclosures (`{"...": digest}`)
 * are refused — no demo credential uses them, and silently skipping them would hide claims.
 */

import { createHash } from 'node:crypto'

export interface SdJwtDisclosure {
  salt: string
  name?: string
  value: unknown
}

export interface DecodedJwt {
  header: Record<string, unknown>
  payload: Record<string, unknown>
}

export interface DecodedSdJwtPresentation {
  issuerJwt: DecodedJwt
  disclosures: SdJwtDisclosure[]
  /** The issuer payload with `_sd` digests replaced by the disclosed values; `_sd` and `_sd_alg` removed. */
  claims: Record<string, unknown>
  keyBinding?: DecodedJwt
}

function decodeBase64UrlJson(segment: string, what: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
  } catch {
    throw new Error(`malformed ${what}`)
  }
}

function decodeJwt(compact: string, what: string): DecodedJwt {
  const parts = compact.split('.')
  if (parts.length !== 3) throw new Error(`malformed ${what}: expected three segments`)
  return {
    header: decodeBase64UrlJson(parts[0], `${what} header`) as Record<string, unknown>,
    payload: decodeBase64UrlJson(parts[1], `${what} payload`) as Record<string, unknown>,
  }
}

function disclosureDigest(encoded: string, alg: string): string {
  if (alg !== 'sha-256') throw new Error(`unsupported _sd_alg: ${alg}`)
  return createHash('sha256').update(encoded, 'ascii').digest('base64url')
}

function resolveDisclosures(node: unknown, byDigest: Map<string, SdJwtDisclosure>): unknown {
  if (Array.isArray(node)) {
    if (node.some((item) => item !== null && typeof item === 'object' && '...' in (item as object))) {
      throw new Error('unsupported: array disclosures')
    }
    return node.map((item) => resolveDisclosures(item, byDigest))
  }
  if (node === null || typeof node !== 'object') return node

  const { _sd, _sd_alg: _ignoredAlg, ...rest } = node as Record<string, unknown>
  const resolved: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rest)) resolved[key] = resolveDisclosures(value, byDigest)
  for (const digest of Array.isArray(_sd) ? (_sd as string[]) : []) {
    const disclosure = byDigest.get(digest)
    // Digests without a disclosure are undisclosed claims or decoys; both are simply absent.
    if (!disclosure?.name) continue
    // The SD-JWT spec rejects a disclosed name that is reserved or already present at this level.
    // Letting it through would let one value silently replace another in what the policy reads.
    if (disclosure.name === '_sd' || disclosure.name === '...') {
      throw new Error('malformed disclosure: reserved claim name')
    }
    if (Object.prototype.hasOwnProperty.call(resolved, disclosure.name)) {
      throw new Error(`malformed disclosure: duplicate claim name "${disclosure.name}"`)
    }
    resolved[disclosure.name] = resolveDisclosures(disclosure.value, byDigest)
  }
  return resolved
}

export function decodeSdJwtPresentation(compact: string): DecodedSdJwtPresentation {
  const segments = compact.trim().split('~')
  if (segments.length < 2) throw new Error('not an SD-JWT presentation: no "~" separator')

  const issuerJwt = decodeJwt(segments[0], 'issuer JWT')
  // Compact form: issuer-jwt ~ disclosure ~ … ~ [kb-jwt]; a trailing "~" means no key binding.
  const last = segments[segments.length - 1]
  const keyBinding = last ? decodeJwt(last, 'key binding JWT') : undefined
  const encodedDisclosures = segments.slice(1, keyBinding ? -1 : undefined).filter(Boolean)

  const alg = String(issuerJwt.payload._sd_alg ?? 'sha-256')
  const byDigest = new Map<string, SdJwtDisclosure>()
  const disclosures = encodedDisclosures.map((encoded) => {
    const parsed = decodeBase64UrlJson(encoded, 'disclosure')
    if (!Array.isArray(parsed) || parsed.length < 2 || parsed.length > 3) throw new Error('malformed disclosure')
    const disclosure: SdJwtDisclosure =
      parsed.length === 3
        ? { salt: String(parsed[0]), name: String(parsed[1]), value: parsed[2] }
        : { salt: String(parsed[0]), value: parsed[1] }
    byDigest.set(disclosureDigest(encoded, alg), disclosure)
    return disclosure
  })

  return {
    issuerJwt,
    disclosures,
    claims: resolveDisclosures(issuerJwt.payload, byDigest) as Record<string, unknown>,
    keyBinding,
  }
}

/** RFC 7638: SHA-256 over the required members of the key, in lexicographic order. */
function jwkThumbprint(jwk: Record<string, unknown>): string {
  const required =
    jwk.kty === 'EC'
      ? ['crv', 'kty', 'x', 'y']
      : jwk.kty === 'OKP'
        ? ['crv', 'kty', 'x']
        : jwk.kty === 'RSA'
          ? ['e', 'kty', 'n']
          : Object.keys(jwk).sort()
  const canonical = JSON.stringify(Object.fromEntries(required.map((key) => [key, jwk[key]])))
  return `urn:ietf:params:oauth:jwk-thumbprint:sha-256:${createHash('sha256').update(canonical).digest('base64url')}`
}

/** `cnf.kid` if present, else the thumbprint of `cnf.jwk`; undefined for a credential without holder binding. */
export function holderBindingOf(decoded: DecodedSdJwtPresentation): string | undefined {
  const cnf = decoded.issuerJwt.payload.cnf as { kid?: unknown; jwk?: Record<string, unknown> } | undefined
  if (!cnf) return undefined
  if (typeof cnf.kid === 'string') return cnf.kid
  if (cnf.jwk && typeof cnf.jwk === 'object') return jwkThumbprint(cnf.jwk)
  return undefined
}
