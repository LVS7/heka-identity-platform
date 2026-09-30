/**
 * What a relying party tells its client about a presentation — built here, once, for both paths.
 *
 * The agent carries it in the A2A extension metadata (`authorizationResult`) and the authorization
 * server in its poll answers (`presentation`). Neither the v1 In-Task Auth extension nor OAuth
 * defines such a thing: it is a demo addition (see src/agent/extension.ts) so the Trust Lens can
 * show what was asked and what was verified without reading the verifier's session itself.
 *
 * `claims` holds only what the holder chose to disclose. `credentialStatus` is a claim the wallet
 * never chose to show (it is not selectively disclosable), so it travels as `status` — the relying
 * party's own check — rather than as something the person presented.
 */

import { InTaskOpenId4VpAuthorizationResult, InTaskOpenId4VpRequested } from '../agent/extension'
import { decodeSdJwtPresentation } from '../core/sd-jwt'
import { PresentedCredential, RefusalReason, StatusCheck } from './presented-credential'

/** The agent's denial when nobody presented before its own timeout; the Trust Lens keys on it. */
export const NO_PRESENTATION_IN_TIME = 'no presentation was received in time'

interface PresentationDefinitionLike {
  purpose?: string
  input_descriptors: Array<{
    constraints: { fields: Array<{ path: string[]; filter?: { enum?: unknown[]; [key: string]: unknown } }> }
  }>
}

/**
 * Plain fields from a Presentation Exchange definition: the `$.vct` enum names the credential
 * type, every other field path is a claim the holder will be asked to disclose.
 */
export function requestedFromDefinition(definition: PresentationDefinitionLike): InTaskOpenId4VpRequested {
  const fields = definition.input_descriptors.flatMap((descriptor) => descriptor.constraints.fields)
  const type = fields.find((field) => field.path.includes('$.vct'))
  return {
    purpose: definition.purpose ?? '',
    credentialType: String(type?.filter?.enum?.[0] ?? ''),
    claims: fields
      .filter((field) => field !== type)
      .flatMap((field) => field.path)
      .map((path) => path.replace(/^\$\./, '')),
  }
}

/** The disclosed claims, read from the disclosures themselves rather than from the merged payload. */
function disclosedClaims(vpToken: string): Record<string, unknown> {
  const { disclosures } = decodeSdJwtPresentation(vpToken)
  return Object.fromEntries(disclosures.filter((d) => d.name).map((d) => [d.name as string, d.value]))
}

export function authorizedResult(
  presented: PresentedCredential,
  status: StatusCheck
): InTaskOpenId4VpAuthorizationResult {
  return {
    sessionId: presented.sessionId,
    outcome: 'authorized',
    claims: disclosedClaims(presented.vpToken),
    issuer: presented.issuer,
    holder: presented.holder,
    credentialType: presented.vct,
    status,
    vpToken: presented.vpToken,
    verifiedAt: presented.verifiedAt,
  }
}

/**
 * A denial keeps what was verified (issuer, holder, type, the token itself) so the audit can show
 * whose credential was refused — but never the disclosed claims: nothing was authorized. Only a
 * revocation reports a status check; every other refusal never read the list.
 */
export function deniedResult(
  sessionId: string,
  reason: string,
  presented?: PresentedCredential,
  refusal?: RefusalReason
): InTaskOpenId4VpAuthorizationResult {
  const result: InTaskOpenId4VpAuthorizationResult = { sessionId, outcome: 'denied', reason }
  if (!presented) return result

  result.issuer = presented.issuer
  result.holder = presented.holder
  result.credentialType = presented.vct
  result.vpToken = presented.vpToken
  result.verifiedAt = presented.verifiedAt
  if (refusal === 'revoked' && presented.credentialStatus) {
    result.status = { ...presented.credentialStatus, revoked: true, checkedAt: new Date().toISOString() }
  }
  return result
}
