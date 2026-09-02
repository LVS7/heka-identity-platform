/**
 * Content digests for ARD attestations and resource cards.
 *
 * ARD leaves the digest encoding to the profile; we use the Subresource Integrity form
 * (`sha256-<base64>`), which is unambiguous and easy to eyeball in a catalog.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

export function sha256Digest(content: string | Buffer): string {
  const hash = createHash('sha256').update(content).digest('base64')
  return `sha256-${hash}`
}

/** Constant-time comparison of two digest strings; false on any malformed input. */
export function digestMatches(expected: string, actual: string): boolean {
  if (!expected || !actual || expected.length !== actual.length) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(actual)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** True when `content` hashes to `expected`. */
export function verifyDigest(content: string | Buffer, expected: string): boolean {
  return digestMatches(expected, sha256Digest(content))
}
