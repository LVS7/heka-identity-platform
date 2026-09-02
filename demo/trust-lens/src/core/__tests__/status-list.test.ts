import { describe, expect, it, vi } from 'vitest'

import {
  BitstringStatusListCredential,
  checkCredentialStatus,
  decodeEncodedList,
  isRevokedInStatusList,
  readStatusBit,
} from '../status-list'

/**
 * Fixtures captured from a live Heka Identity Service (status list of size 1000,
 * issuer did:hedera:testnet:...): one before any revocation, one after revoking index 5.
 */
const ALL_CLEAR = 'uH4sIAAAAAAAAA2NgGEAAAKh0odt9AAAA'
const REVOKED_AT_5 = 'uH4sIAAAAAAAAA2NhGEAAAK_6d7Z9AAAA'

const statusListCredential = (encodedList: string): BitstringStatusListCredential => ({
  id: '962a1287-53e6-4c39-9d07-e647e7bf8f02',
  issuer: 'did:hedera:testnet:k5rVjvauXrXsNeohwN6GQgGmLiwLut5nUrQUUCxcgjK_0.0.10152119',
  credentialSubject: { type: 'BitstringStatusList', statusPurpose: 'revocation', encodedList },
})

describe('decodeEncodedList', () => {
  it('decodes a multibase base64url + GZIP bitstring to the declared size', () => {
    // 1000 bits requested → 125 bytes
    expect(decodeEncodedList(ALL_CLEAR)).toHaveLength(125)
  })

  it('tolerates a plain base64url string without the multibase prefix', () => {
    expect(decodeEncodedList(ALL_CLEAR.slice(1))).toHaveLength(125)
  })

  it('throws on empty input', () => {
    expect(() => decodeEncodedList('')).toThrow(/empty/)
  })
})

describe('readStatusBit', () => {
  it('reads bits most-significant-first within a byte', () => {
    const bitstring = Buffer.from([0b0000_0100]) // only index 5 set
    expect(readStatusBit(bitstring, 5)).toBe(true)
    expect(readStatusBit(bitstring, 4)).toBe(false)
    expect(readStatusBit(bitstring, 6)).toBe(false)
  })

  it('throws when the index is outside the bitstring', () => {
    expect(() => readStatusBit(Buffer.alloc(1), 8)).toThrow(/exceeds bitstring length/)
    expect(() => readStatusBit(Buffer.alloc(1), -1)).toThrow(/out of range/)
  })
})

describe('isRevokedInStatusList', () => {
  it('reports not revoked for a freshly created list', () => {
    expect(isRevokedInStatusList(statusListCredential(ALL_CLEAR), 5)).toBe(false)
  })

  it('reports revoked for the exact index that was revoked', () => {
    expect(isRevokedInStatusList(statusListCredential(REVOKED_AT_5), 5)).toBe(true)
  })

  it('leaves neighbouring indexes untouched (per-credential granularity)', () => {
    const list = statusListCredential(REVOKED_AT_5)
    expect(isRevokedInStatusList(list, 4)).toBe(false)
    expect(isRevokedInStatusList(list, 6)).toBe(false)
  })
})

describe('checkCredentialStatus', () => {
  const status = {
    statusListCredential: 'http://localhost:3000/credentials/status/962a1287-53e6-4c39-9d07-e647e7bf8f02',
    statusListIndex: 5,
  }

  it('fetches the status list and returns the bit for the credential', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => statusListCredential(REVOKED_AT_5),
    }) as unknown as typeof fetch

    await expect(checkCredentialStatus(status, fetchFn)).resolves.toBe(true)
    expect(fetchFn).toHaveBeenCalledWith(status.statusListCredential)
  })

  it('fails loudly when the status list cannot be fetched (fail closed)', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch
    await expect(checkCredentialStatus(status, fetchFn)).rejects.toThrow(/HTTP 503/)
  })
})
