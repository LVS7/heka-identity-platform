import { describe, expect, it } from 'vitest'

import { digestMatches, sha256Digest, verifyDigest } from '../digest'

describe('sha256Digest', () => {
  it('produces a subresource-integrity style digest', () => {
    // echo -n "hello" | openssl dgst -sha256 -binary | base64
    expect(sha256Digest('hello')).toBe('sha256-LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=')
  })

  it('is stable across string and buffer input', () => {
    expect(sha256Digest(Buffer.from('hello'))).toBe(sha256Digest('hello'))
  })
})

describe('verifyDigest', () => {
  it('accepts matching content', () => {
    expect(verifyDigest('catalog bytes', sha256Digest('catalog bytes'))).toBe(true)
  })

  it('rejects content that was swapped after attestation', () => {
    expect(verifyDigest('tampered bytes', sha256Digest('catalog bytes'))).toBe(false)
  })
})

describe('digestMatches', () => {
  it('rejects empty or mismatched-length input rather than throwing', () => {
    expect(digestMatches('', 'sha256-x')).toBe(false)
    expect(digestMatches('sha256-x', '')).toBe(false)
    expect(digestMatches('sha256-short', 'sha256-a-much-longer-value')).toBe(false)
  })
})
