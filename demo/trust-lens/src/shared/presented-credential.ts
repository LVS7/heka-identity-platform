/**
 * What a relying party decides about a presented credential — the part Heka does not do.
 *
 * Heka's verifier confirms a presentation is cryptographically sound: issuer signature, key
 * binding, nonce. It does not decide whose credentials this relying party accepts, what type it
 * expected, or whether the credential is still live — and it does not constrain the issuer at
 * all. Both relying parties in this demo (the A2A agent and the authorization server) make those
 * decisions here, against the presented token itself. Nothing is read from the seed state except
 * the trust anchor, and nothing here ever answers "unknown": every failure to evaluate is a
 * refusal with a reason.
 */

import { decodeSdJwtPresentation, DecodedSdJwtPresentation, holderBindingOf } from '../core/sd-jwt'
import { checkCredentialStatus } from '../core/status-list'
import { CredentialStatusClaim } from '../core/types'
import { VerificationSessionRecord } from './identity-service'

export interface PresentedCredential {
  sessionId: string
  vct: string
  issuer: string
  holder?: string
  /** Disclosed and non-selectively-disclosable claims together (role, org, credentialStatus, …). */
  claims: Record<string, unknown>
  credentialStatus?: CredentialStatusClaim
  /** The compact SD-JWT presentation as verified by Heka — the holder's own signature over the claim. */
  vpToken: string
  verifiedAt: string
}

export interface PresentationPolicy {
  trustedIssuers: string[]
  requiredVct: string
  /** Origin of the Identity Service: the issuer's status lists live there and nowhere else. */
  statusListOrigin: string
  /** Human label used in refusal messages, e.g. "Finance Data Officer". */
  credentialLabel: string
  /**
   * Claims that must be disclosed with exactly this value, e.g. `{ role: 'Finance Data Officer' }`.
   * The type says what kind of credential it is; only the disclosed role says what the holder may do.
   */
  requiredClaims: Record<string, string>
}

export interface StatusCheck {
  statusListCredential: string
  statusListIndex: number
  revoked: boolean
  checkedAt: string
}

export type RefusalReason =
  | 'not-verified'
  | 'malformed'
  | 'wrong-type'
  | 'untrusted-issuer'
  | 'wrong-role'
  | 'no-status'
  | 'foreign-status-list'
  | 'status-unavailable'
  | 'revoked'

export class PresentationRefused extends Error {
  public constructor(
    public readonly reason: RefusalReason,
    message: string
  ) {
    super(message)
    this.name = 'PresentationRefused'
  }
}

const notVerified = (state: string) =>
  new PresentationRefused('not-verified', `no verified presentation yet (session is ${state})`)

const malformed = (detail: string) =>
  new PresentationRefused('malformed', `presentation could not be decoded: ${detail}`)

/** Only called once the session is ResponseVerified: a missing token then is a broken response, not "not yet". */
function vpTokenOf(session: VerificationSessionRecord): string {
  const raw = session.authorizationResponsePayload?.vp_token
  // OID4VP allows a single presentation or an array; this demo asks for exactly one credential,
  // so any other count is refused rather than silently judging whichever came first.
  if (Array.isArray(raw) && raw.length !== 1) {
    throw malformed(`expected exactly one presentation, got ${raw.length}`)
  }
  const compact = Array.isArray(raw) ? raw[0] : raw
  if (typeof compact !== 'string' || !compact) {
    throw malformed('vp_token is missing')
  }
  return compact
}

/**
 * Pure: decode what the session holds. Throws `not-verified` unless the state is ResponseVerified,
 * and `malformed` when a verified session carries no single decodable vp_token.
 */
export function readPresentedCredential(session: VerificationSessionRecord): PresentedCredential {
  if (session.state !== 'ResponseVerified') {
    throw notVerified(session.state)
  }

  const vpToken = vpTokenOf(session)
  let decoded: DecodedSdJwtPresentation
  try {
    decoded = decodeSdJwtPresentation(vpToken)
  } catch (error) {
    // Heka accepted the token, so this should not happen — and if it does, it is still a refusal.
    throw malformed((error as Error).message)
  }
  const status = decoded.claims.credentialStatus as CredentialStatusClaim | undefined

  return {
    sessionId: session.id,
    vct: String(decoded.claims.vct ?? ''),
    issuer: String(decoded.issuerJwt.payload.iss ?? ''),
    holder: holderBindingOf(decoded),
    claims: decoded.claims,
    credentialStatus: status,
    vpToken,
    verifiedAt: new Date().toISOString(),
  }
}

/** Origin of a status pointer, or undefined when it is not a URL. Exported so refusals can log it. */
export function statusListOriginOf(status: CredentialStatusClaim): string | undefined {
  try {
    return new URL(String(status.statusListCredential)).origin
  } catch {
    return undefined
  }
}

/**
 * Policy plus live status. Resolves with the status check that was performed; rejects with a
 * `PresentationRefused` naming why. Never resolves without having read the status list.
 */
export async function assertPresentedCredentialValid(
  presented: PresentedCredential,
  policy: PresentationPolicy,
  fetchFn: typeof fetch = fetch
): Promise<StatusCheck> {
  if (presented.vct !== policy.requiredVct) {
    throw new PresentationRefused('wrong-type', `credential is not a ${policy.requiredVct}`)
  }
  if (!presented.issuer || !policy.trustedIssuers.includes(presented.issuer)) {
    throw new PresentationRefused(
      'untrusted-issuer',
      `credential issued by ${presented.issuer || '(none)'}, which this relying party does not trust`
    )
  }
  for (const [name, expected] of Object.entries(policy.requiredClaims)) {
    if (presented.claims[name] !== expected) {
      throw new PresentationRefused(
        'wrong-role',
        `credential claim "${name}" is "${String(presented.claims[name] ?? '')}", expected "${expected}"`
      )
    }
  }

  const status = presented.credentialStatus
  if (!status) {
    throw new PresentationRefused('no-status', 'credential carries no status pointer and cannot be revoked')
  }

  if (statusListOriginOf(status) !== policy.statusListOrigin) {
    throw new PresentationRefused(
      'foreign-status-list',
      "credential points at a status list outside the issuer's service"
    )
  }

  let revoked: boolean
  try {
    revoked = await checkCredentialStatus(status, fetchFn)
  } catch (error) {
    // checkCredentialStatus already says "status list unavailable: …" for a failed fetch; keep the cause only.
    const cause = (error as Error).message.replace(/^status list unavailable: /, '')
    throw new PresentationRefused('status-unavailable', `status list unavailable, refusing to assume valid: ${cause}`)
  }
  if (revoked) {
    throw new PresentationRefused('revoked', `the ${policy.credentialLabel} credential has been revoked by its issuer`)
  }

  return {
    statusListCredential: status.statusListCredential,
    statusListIndex: status.statusListIndex,
    revoked: false,
    checkedAt: new Date().toISOString(),
  }
}
