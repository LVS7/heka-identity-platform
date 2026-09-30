/**
 * W3C Bitstring Status List support — the demo's revocation ("kill switch") mechanism.
 *
 * Why app-layer: Heka Identity Service does not embed a `credentialStatus` pointer into
 * issued SD-JWT VCs (its native OID4VC revocation covers JwtVcJson/JwtVcJsonLd/LdpVc only),
 * and its verifier does not check status automatically. Since we control the credential
 * payload at issuance, we put the pointer in as a normal (non-selectively-disclosable) claim
 * and check it here, in the relying party — consistent with the SSI principle that the
 * relying party decides trust.
 *
 * Status list credentials are published by Heka at GET /credentials/status/{id} (public).
 */

import { gunzipSync } from 'node:zlib'

import { CredentialStatusClaim } from './types'

export interface BitstringStatusListCredential {
  id?: string
  issuer?: string
  validFrom?: string
  credentialSubject: {
    type?: string
    statusPurpose?: string
    /** Multibase base64url ('u' prefix) of the GZIP-compressed bitstring. */
    encodedList: string
  }
}

/** Decode a W3C `encodedList` (multibase base64url + GZIP) into raw bitstring bytes. */
export function decodeEncodedList(encodedList: string): Buffer {
  if (!encodedList) throw new Error('encodedList is empty')

  // Multibase: 'u' = base64url (no padding). Tolerate a plain base64url string too.
  const withoutPrefix = encodedList.startsWith('u') ? encodedList.slice(1) : encodedList
  const padded = withoutPrefix + '='.repeat((4 - (withoutPrefix.length % 4)) % 4)
  const compressed = Buffer.from(padded, 'base64url')

  return gunzipSync(compressed)
}

/** Read a single status bit. Bits are indexed most-significant-first within each byte. */
export function readStatusBit(bitstring: Buffer, index: number): boolean {
  // A NaN or fractional index would silently read byte 0 — "not revoked" by accident.
  if (!Number.isInteger(index) || index < 0) throw new Error(`statusListIndex out of range: ${index}`)

  const byteIndex = Math.floor(index / 8)
  if (byteIndex >= bitstring.length) {
    throw new Error(`statusListIndex ${index} exceeds bitstring length (${bitstring.length * 8} bits)`)
  }

  const bitInByte = 7 - (index % 8)
  return ((bitstring[byteIndex] >> bitInByte) & 1) === 1
}

/** True when the credential at `index` is revoked according to the given status list credential. */
export function isRevokedInStatusList(statusList: BitstringStatusListCredential, index: number): boolean {
  const bitstring = decodeEncodedList(statusList.credentialSubject.encodedList)
  return readStatusBit(bitstring, index)
}

export interface StatusCheckOptions {
  /** How long to wait for the status list before refusing. A hanging list is not a live list. */
  timeoutMs?: number
}

const DEFAULT_STATUS_TIMEOUT_MS = 10_000

/** The claim is signed by the issuer, but a malformed one must still refuse rather than pass. */
function assertStatusClaim(status: CredentialStatusClaim): void {
  if (typeof status?.statusListCredential !== 'string' || !/^https?:\/\//.test(status.statusListCredential)) {
    throw new Error('credentialStatus.statusListCredential must be an http(s) URL')
  }
  if (!Number.isInteger(status.statusListIndex) || status.statusListIndex < 0) {
    throw new Error(
      `credentialStatus.statusListIndex must be a non-negative integer, got ${String(status.statusListIndex)}`
    )
  }
}

/**
 * Fetch the status list credential referenced by a credential's `credentialStatus` claim
 * and report whether that credential is revoked. Every failure throws: the caller decides
 * trust, and "could not check" is never "not revoked".
 */
export async function checkCredentialStatus(
  status: CredentialStatusClaim,
  fetchFn: typeof fetch = fetch,
  options: StatusCheckOptions = {}
): Promise<boolean> {
  assertStatusClaim(status)

  let response: Response
  try {
    response = await fetchFn(status.statusListCredential, {
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(`status list unavailable: ${(error as Error).message} for ${status.statusListCredential}`)
  }
  if (!response.ok) {
    throw new Error(`status list fetch failed: HTTP ${response.status} for ${status.statusListCredential}`)
  }

  const statusList = (await response.json()) as BitstringStatusListCredential
  return isRevokedInStatusList(statusList, status.statusListIndex)
}
