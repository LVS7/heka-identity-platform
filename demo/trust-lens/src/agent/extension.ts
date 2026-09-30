/**
 * OID4VP In-Task Authorization Extension for A2A.
 *
 * `authorizationRequest` mirrors the published extension (v1) so the wire format is the spec's,
 * not ours: https://github.com/a2aproject/experimental-ext-oid4vp-auth
 *
 * The v1 spec defines nothing after the request — no session state, no disclosed claims, no
 * result. `authorizationStatus` and `authorizationResult` are **demo additions** under the same
 * metadata key. They exist so the client can show what is asked, how far the exchange has got and
 * what was verified without touching the verifier's session: fetching the `request_uri` from the
 * client would move Heka's session to `RequestUriRetrieved` and corrupt the very signal being
 * shown, so everything the client learns travels in-band from the relying party.
 */

import { AgentExtension, ExtensionURI } from '@a2a-js/sdk'

import type { StatusCheck } from '../shared/presented-credential'

export const IN_TASK_OID4VP_EXTENSION_URI: ExtensionURI =
  'https://github.com/DSRCorporation/a2a-oid4vp-in-task-auth-extension/tree/main/v1'

/** Spec (v1): carried on `auth-required`. */
export interface InTaskOpenId4VpAuthorizationRequest {
  client_id: string
  request_uri: string
}

/** Demo addition: the presentation definition in plain fields, so the UI can say what is asked before anyone scans. */
export interface InTaskOpenId4VpRequested {
  purpose: string
  credentialType: string
  claims: string[]
}

/** Demo addition: carried on `auth-required` and on each `working` update while the agent waits. */
export interface InTaskOpenId4VpAuthorizationStatus {
  sessionId: string
  /** Heka's verification-session state, forwarded as is. */
  state: 'RequestCreated' | 'RequestUriRetrieved' | 'ResponseVerified' | string
  /** When the agent stops waiting — its own timeout, not the verifier session's (shorter, unexposed) lifetime. */
  expiresAt: string
  requested: InTaskOpenId4VpRequested
}

/** Demo addition: carried on `completed` (authorized) and on `failed` (denied). */
export interface InTaskOpenId4VpAuthorizationResult {
  sessionId: string
  outcome: 'authorized' | 'denied'
  /** The denial message — see the refusal table in src/shared/presented-credential.ts. */
  reason?: string
  /** Only the claims the holder disclosed (role, org). */
  claims?: Record<string, unknown>
  issuer?: string
  holder?: string
  credentialType?: string
  status?: StatusCheck
  /** The compact SD-JWT presentation — the holder's own signature over the claims. */
  vpToken?: string
  verifiedAt?: string
}

export interface InTaskOpenId4VpMessageMetadata {
  /** auth-required (spec) */
  authorizationRequest?: InTaskOpenId4VpAuthorizationRequest
  /** auth-required, working (demo) */
  authorizationStatus?: InTaskOpenId4VpAuthorizationStatus
  /** completed, failed (demo) */
  authorizationResult?: InTaskOpenId4VpAuthorizationResult
}

export interface InTaskOpenId4VpExtension extends AgentExtension {
  params: { oid4vpVersions: string[] }
}
