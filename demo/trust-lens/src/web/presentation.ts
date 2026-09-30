/**
 * The Trust Lens's view of an authorization and of the presentation that settled it — one shape
 * for both paths, so an A2A task and an MCP step-up render with the same strip and the same card.
 *
 * The relying party cannot tell a simulated holder from a phone: both run the same OID4VP
 * exchange. Only the Trust Lens knows which button was pressed, so the source is decided here, on
 * the client side of the protocol, and travels into the audit with the presentation (invariant 7).
 */

import { InTaskOpenId4VpAuthorizationResult, InTaskOpenId4VpRequested } from '../agent/extension'
import { DeliveryState } from './wallet-delivery'

export type PresentationSource = 'wallet' | 'qr' | 'simulated' | 'unknown'

export type AuthorizationState = 'requested' | 'wallet-fetched' | 'verified' | 'authorized' | 'denied' | 'expired'

export interface AuthorizationView {
  /** The openid4vp:// URI — what the QR encodes and what is pushed to the wallet. */
  request: string
  clientId?: string
  sessionId?: string
  state: AuthorizationState
  /** The relying party's own deadline (the agent's timeout); the MCP path has none. */
  expiresAt?: string
  requested?: InTaskOpenId4VpRequested
  /** Last attempt to push the request to the operator's wallet, if any. */
  delivery?: DeliveryState
  source?: PresentationSource
}

export interface PresentationView extends InTaskOpenId4VpAuthorizationResult {
  source: PresentationSource
}

const SESSION_STATES: Record<string, AuthorizationState> = {
  RequestCreated: 'requested',
  RequestUriRetrieved: 'wallet-fetched',
  ResponseVerified: 'verified',
}

/** Heka's session states as the strip shows them; anything else means the wallet has not moved. */
export function toAuthorizationState(sessionState: string): AuthorizationState {
  return SESSION_STATES[sessionState] ?? 'requested'
}

/**
 * Where the presentation came from. A pressed button is recorded on the authorization; a token that
 * arrived with nothing pressed was scanned; a denial without a token had no presentation at all.
 */
export function sourceOf(
  authorization: AuthorizationView | undefined,
  result: InTaskOpenId4VpAuthorizationResult
): PresentationSource {
  if (authorization?.source) return authorization.source
  return result.vpToken ? 'qr' : 'unknown'
}

export function presentationFrom(
  result: InTaskOpenId4VpAuthorizationResult,
  source: PresentationSource = 'unknown'
): PresentationView {
  return { ...result, source }
}
