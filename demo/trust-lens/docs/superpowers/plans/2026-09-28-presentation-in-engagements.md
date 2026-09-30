# T3 — Presentation in engagements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the verified presentation part of the engagement on both protocols — carried in-band from the relying party, kept by the Trust Lens on the task / the step-up and in the audit, and shown as a card with live steps, a countdown and a labelled source.

**Architecture:** The A2A extension metadata gains two documented demo fields (`authorizationStatus` on the way in, `authorizationResult` on the way out) built by one shared module, `src/shared/authorization-result.ts`; the authorization server mirrors the same result in its poll answers. The Trust Lens folds both into one view model (`src/web/presentation.ts`), keeps it on `TrackedTask` / `PendingAuthorization` and in the audit evidence, and the UI gets a Tasks tab, pollers that survive navigation, a step strip, two countdowns and a presentation card with a Raw VP drawer.

**Tech Stack:** TypeScript (`tsx`), Express 5, `@a2a-js/sdk` 0.3, vitest 3, vanilla browser JS/CSS (no build step), Heka Identity Service REST.

**Brief:** `docs/tasks/03-presentation-in-engagements.md` is the source of truth for scope, DoD and validation. Two code-level choices not in the brief: (1) the pending MCP authorization is owned by `McpClient` (not a `let` in `server.ts`) so the reuse rule is unit-testable; (2) the browser pollers are keyed `task`, `tasks`, `mcp-auth` — one task is watched at a time, and a task's progress lives on the server anyway.

## Global Constraints

- English throughout — code, comments, docs, commit messages. Comments explain _why_.
- `src/core` stays dependency-light (Node built-ins only). New shared code goes in `src/shared` / `src/web`.
- Prettier: `printWidth: 120`, no semicolons, single quotes, `arrowParens: always`, trailing commas `es5`, LF. Run `yarn prettier --check <files>` on every file touched.
- `yarn typecheck` and `yarn test` must pass after every task; never add `// @ts-expect-error`. `node --check` on every changed browser script.
- Invariant 7 — simulation is labelled: the source (`wallet` / `qr` / `simulated`) is set only by the Trust Lens and travels into the audit; both simulate routes record `presentation submitted (simulated holder)`.
- Invariant 6 — refusals are audited: every `denial` entry that has a presentation carries `evidence.presentation`.
- The presentation definition does not change (`role`, `org`, `limit_disclosure: required`). The text parts of the agent's messages do not change.
- Exact strings the UI and docs key on:
  - agent `working` on `RequestUriRetrieved` → `The wallet fetched the request.`
  - agent `working` on `ResponseVerified` → `Presentation verified; checking the credential's status.`
  - agent timeout denial → `no presentation was received in time` (exported as `NO_PRESENTATION_IN_TIME`)
  - audit → `presentation submitted (simulated holder)`, `task completed after verified presentation`, `scoped token issued against a verified presentation`
- Work from `demo/trust-lens`; commits on `task/03-presentation-ux`; commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; use `git -c core.safecrlf=false commit` if git complains about CRLF.
- The demo services run on the host (web :4000, agent :10003, AS :4300, MCP :4400, Heka :3000/:3003) and belong to the operator: do not start, stop or restart them. Live validation happens after the operator restarts `yarn web`, `yarn agent`, `yarn as`; until then verification is static (typecheck, tests, `node --check`, prettier).

---

### Task 1: The contract — extension types and the shared result builder

**Files:**

- Modify: `src/agent/extension.ts` (whole file)
- Create: `src/shared/authorization-result.ts`
- Test: `src/shared/__tests__/authorization-result.test.ts`

**Interfaces:**

- Produces (from `src/agent/extension.ts`): `InTaskOpenId4VpRequested { purpose: string; credentialType: string; claims: string[] }`, `InTaskOpenId4VpAuthorizationStatus { sessionId; state; expiresAt; requested }`, `InTaskOpenId4VpAuthorizationResult { sessionId; outcome: 'authorized' | 'denied'; reason?; claims?; issuer?; holder?; credentialType?; status?: StatusCheck; vpToken?; verifiedAt? }`, `InTaskOpenId4VpMessageMetadata { authorizationRequest?; authorizationStatus?; authorizationResult? }`.
- Produces (from `src/shared/authorization-result.ts`): `NO_PRESENTATION_IN_TIME: string`, `requestedFromDefinition(definition): InTaskOpenId4VpRequested`, `authorizedResult(presented: PresentedCredential, status: StatusCheck): InTaskOpenId4VpAuthorizationResult`, `deniedResult(sessionId: string, reason: string, presented?: PresentedCredential, refusal?: RefusalReason): InTaskOpenId4VpAuthorizationResult`.

- [ ] **Step 1: Write the failing test**

Create `src/shared/__tests__/authorization-result.test.ts`:

```ts
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { ROLE_CREDENTIAL_VCT } from '../../core/types'
import { authorizedResult, deniedResult, requestedFromDefinition } from '../authorization-result'
import { PresentedCredential } from '../presented-credential'

const TRUSTCO = 'did:hedera:testnet:trustco_0.0.1'
const HOLDER = 'did:key:z6MkHolder#key-1'
const STATUS_LIST_URL = 'http://localhost:3000/credentials/status/list-1'

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const digest = (disclosure: string) => createHash('sha256').update(disclosure, 'ascii').digest('base64url')

/** What readPresentedCredential returns for the officer credential, with a real compact token. */
function presentedOfficer(): PresentedCredential {
  const disclosures = [b64(['salt-role', 'role', 'Finance Data Officer']), b64(['salt-org', 'org', 'TrustCo'])]
  const credentialStatus = { statusListCredential: STATUS_LIST_URL, statusListIndex: 3 }
  const payload = {
    vct: ROLE_CREDENTIAL_VCT,
    iss: TRUSTCO,
    cnf: { kid: HOLDER },
    credentialStatus,
    _sd_alg: 'sha-256',
    _sd: disclosures.map(digest),
  }
  const issuerJwt = `${b64({ alg: 'EdDSA' })}.${b64(payload)}.sig`
  const kbJwt = `${b64({ typ: 'kb+jwt' })}.${b64({ aud: 'did:key:verifier' })}.sig`
  return {
    sessionId: 'session-1',
    vct: ROLE_CREDENTIAL_VCT,
    issuer: TRUSTCO,
    holder: HOLDER,
    claims: { ...payload, role: 'Finance Data Officer', org: 'TrustCo' },
    credentialStatus,
    vpToken: `${issuerJwt}~${disclosures.join('~')}~${kbJwt}`,
    verifiedAt: '2026-09-28T10:00:00.000Z',
  }
}

const LIVE = {
  statusListCredential: STATUS_LIST_URL,
  statusListIndex: 3,
  revoked: false,
  checkedAt: '2026-09-28T10:00:01.000Z',
}

describe('requestedFromDefinition', () => {
  it('names the type from the vct enum and every other path as a claim', () => {
    const requested = requestedFromDefinition({
      purpose: 'Authorize preparation of a supplier payment export',
      input_descriptors: [
        {
          constraints: {
            fields: [
              { path: ['$.vct'], filter: { type: 'string', enum: [ROLE_CREDENTIAL_VCT] } },
              { path: ['$.role'], filter: { type: 'string', enum: ['Finance Data Officer'] } },
              { path: ['$.org'], filter: { type: 'string' } },
            ],
          },
        },
      ],
    })

    expect(requested).toEqual({
      purpose: 'Authorize preparation of a supplier payment export',
      credentialType: ROLE_CREDENTIAL_VCT,
      claims: ['role', 'org'],
    })
  })
})

describe('authorizedResult', () => {
  it('carries the disclosed claims only, plus issuer, holder, type, status and the token', () => {
    const result = authorizedResult(presentedOfficer(), LIVE)

    expect(result).toMatchObject({
      sessionId: 'session-1',
      outcome: 'authorized',
      claims: { role: 'Finance Data Officer', org: 'TrustCo' },
      issuer: TRUSTCO,
      holder: HOLDER,
      credentialType: ROLE_CREDENTIAL_VCT,
      status: LIVE,
      verifiedAt: '2026-09-28T10:00:00.000Z',
    })
    expect(Object.keys(result.claims ?? {})).toEqual(['role', 'org'])
    expect(result.vpToken?.startsWith('ey')).toBe(true)
  })
})

describe('deniedResult', () => {
  it('is only the reason when nothing was presented', () => {
    expect(deniedResult('session-1', 'no presentation was received in time')).toEqual({
      sessionId: 'session-1',
      outcome: 'denied',
      reason: 'no presentation was received in time',
    })
  })

  it('keeps whose credential was refused and the failed status check, never the claims', () => {
    const reason = 'the Finance Data Officer credential has been revoked by its issuer'
    const result = deniedResult('session-1', reason, presentedOfficer(), 'revoked')

    expect(result.claims).toBeUndefined()
    expect(result).toMatchObject({ outcome: 'denied', reason, issuer: TRUSTCO, holder: HOLDER })
    expect(result.status).toMatchObject({ statusListIndex: 3, revoked: true })
    expect(result.vpToken).toBeTruthy()
  })

  it('reports no status check for a refusal that never read the list', () => {
    const result = deniedResult(
      'session-1',
      'credential issued by x, which this relying party does not trust',
      presentedOfficer(),
      'untrusted-issuer'
    )
    expect(result.status).toBeUndefined()
    expect(result.issuer).toBe(TRUSTCO)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn vitest run src/shared/__tests__/authorization-result.test.ts`
Expected: FAIL — `Cannot find module '../authorization-result'`.

- [ ] **Step 3: Rewrite `src/agent/extension.ts`**

Replace the whole file with:

```ts
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
```

- [ ] **Step 4: Create `src/shared/authorization-result.ts`**

```ts
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
    constraints: { fields: Array<{ path: string[]; filter?: { enum?: unknown[] } }> }
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
```

- [ ] **Step 5: Run the test and the checks**

Run: `yarn vitest run src/shared/__tests__/authorization-result.test.ts && yarn typecheck && yarn prettier --check src/agent/extension.ts src/shared/authorization-result.ts src/shared/__tests__/authorization-result.test.ts`
Expected: 5 tests pass; typecheck clean (tasks.ts still compiles: it casts the metadata itself); prettier clean (run `--write` if not).

- [ ] **Step 6: Commit**

```bash
git add src/agent/extension.ts src/shared/authorization-result.ts src/shared/__tests__/authorization-result.test.ts
git -c core.safecrlf=false commit -m "feat(extension): say what is asked and what was verified, as a labelled demo addition

The v1 In-Task Auth extension stops at the request. The Trust Lens cannot read the verifier's
session (the first fetch of request_uri would move it to RequestUriRetrieved), so the status and
the result travel in-band under the same metadata key, built once for both relying parties.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The agent emits status and result

**Files:**

- Modify: `src/agent/index.ts` (imports; `InvoiceAgentExecutor` fields; `onNotification`; `execute`; `awaitAuthorization`; `waitForVerifiedPresentation`)

**Interfaces:**

- Consumes: Task 1's types and builders.
- Produces on the wire: `auth-required` metadata `{ authorizationRequest, authorizationStatus }`; `working` updates with `{ authorizationStatus }` on every session state change; `completed` with `{ authorizationResult }` (outcome `authorized`); `failed` with `{ authorizationResult }` (outcome `denied`) for an `AuthorizationDenied`.

- [ ] **Step 1: Imports and the requested block**

In `src/agent/index.ts` replace the import of `./extension` and the `presented-credential` import with:

```ts
import {
  authorizedResult,
  deniedResult,
  NO_PRESENTATION_IN_TIME,
  requestedFromDefinition,
} from '../shared/authorization-result'
import {
  assertPresentedCredentialValid,
  PresentationRefused,
  PresentedCredential,
  readPresentedCredential,
  StatusCheck,
  statusListOriginOf,
} from '../shared/presented-credential'
import {
  IN_TASK_OID4VP_EXTENSION_URI,
  InTaskOpenId4VpAuthorizationRequest,
  InTaskOpenId4VpAuthorizationResult,
  InTaskOpenId4VpAuthorizationStatus,
  InTaskOpenId4VpExtension,
  InTaskOpenId4VpMessageMetadata,
} from './extension'
```

Directly after the `OFFICER_PRESENTATION_DEFINITION` constant add:

```ts
/** The same definition in plain fields, so the client can show what is asked (demo addition). */
const OFFICER_REQUESTED = requestedFromDefinition(OFFICER_PRESENTATION_DEFINITION)

/** What the agent says as the wallet moves the verifier session along; other states are silent. */
const SESSION_STATE_TEXT: Record<string, string> = {
  RequestUriRetrieved: 'The wallet fetched the request.',
  ResponseVerified: "Presentation verified; checking the credential's status.",
}
```

- [ ] **Step 2: Carry the result on the denial**

Replace `class AuthorizationDenied extends Error {}` with:

```ts
class AuthorizationDenied extends Error {
  public constructor(
    message: string,
    /** What the client is told (demo addition); absent only when the denial has no session. */
    public readonly result?: InTaskOpenId4VpAuthorizationResult
  ) {
    super(message)
    this.name = 'AuthorizationDenied'
  }
}
```

- [ ] **Step 3: Track session states, not just "verified"**

Replace the field `private readonly verifiedSessions = new Set<string>()` with:

```ts
  /** Latest Heka state per session this agent opened — what `authorizationStatus` forwards. */
  private readonly sessionStates = new Map<string, string>()
```

In `onNotification`, replace the last two lines of the function (the `console.log` and the `if (session.state === 'ResponseVerified')`) with:

```ts
// Heka notifies for every session in the tenant, the AS's included; only ours are tracked.
if (!this.sessionToContext.has(session.id)) return
console.log(`[agent] session ${session.id.slice(0, 8)} -> ${session.state}`)
if (session.state) this.sessionStates.set(session.id, session.state)
```

- [ ] **Step 4: Emit in `execute`**

Replace the block from `const { request, sessionId } = await this.requestAuthorization(contextId)` through `say('working', 'Authorization accepted. Preparing the payment export…')` with:

```ts
const { request, sessionId } = await this.requestAuthorization(contextId)
// The agent's own deadline; the verifier session has a shorter lifetime Heka does not expose.
const expiresAt = new Date(Date.now() + AUTHORIZATION_TIMEOUT_MS).toISOString()
const statusOf = (state: string): InTaskOpenId4VpAuthorizationStatus => ({
  sessionId,
  state,
  expiresAt,
  requested: OFFICER_REQUESTED,
})

say('auth-required', 'Present a Finance Data Officer credential to authorize the payment export.', {
  metadata: withExtension({ authorizationRequest: request, authorizationStatus: statusOf('RequestCreated') }),
})

const { presented, status } = await this.awaitAuthorization(sessionId, contextId, expiresAt, (state) => {
  const text = SESSION_STATE_TEXT[state]
  if (text) say('working', text, { metadata: withExtension({ authorizationStatus: statusOf(state) }) })
})
result = authorizedResult(presented, status)
say('working', 'Authorization accepted. Preparing the payment export…')
```

Before the `try {` in `execute` (after the `say` helper) add:

```ts
// Set only when this task ran the authorization itself; a context authorized earlier has none.
let result: InTaskOpenId4VpAuthorizationResult | undefined
```

Replace `say('completed', report)` with:

```ts
say('completed', report, result ? { metadata: withExtension({ authorizationResult: result }) } : undefined)
```

Replace the `say('failed', …)` call in the `catch` with:

```ts
const message = (error as Error).message
say(
  'failed',
  denied ? `Authorization denied: ${message}` : `Agent error: ${message}`,
  denied && error.result ? { metadata: withExtension({ authorizationResult: error.result }) } : undefined
)
```

(`denied` narrows `error` to `AuthorizationDenied`; keep the existing `const denied = error instanceof AuthorizationDenied` line and the log line above it.)

Add a module-level helper next to `agentCard()`:

```ts
/** The extension's metadata slot: one key, spec field plus the labelled demo additions. */
function withExtension(metadata: InTaskOpenId4VpMessageMetadata): Record<string, unknown> {
  return { [IN_TASK_OID4VP_EXTENSION_URI]: metadata }
}
```

- [ ] **Step 5: `awaitAuthorization` and `waitForVerifiedPresentation`**

Change the signature of `awaitAuthorization` to:

```ts
  private async awaitAuthorization(
    sessionId: string,
    contextId: string,
    expiresAt: string,
    onState: (state: string) => void
  ): Promise<{ presented: PresentedCredential; status: StatusCheck }> {
    await this.waitForVerifiedPresentation(sessionId, Date.parse(expiresAt), onState)
```

In its `catch`, replace `throw new AuthorizationDenied(error.message)` with:

```ts
throw new AuthorizationDenied(error.message, deniedResult(sessionId, error.message, presented, error.reason))
```

Replace the whole `waitForVerifiedPresentation` method with:

```ts
  /**
   * Resolve once Heka reports `ResponseVerified`, calling `onState` on every state change on the
   * way (the wallet fetching the request is the first sign of life the operator can see). The
   * WebSocket is the fast path; every few seconds Heka is asked directly in case a notification
   * fell into a reconnect gap.
   */
  private waitForVerifiedPresentation(
    sessionId: string,
    deadline: number,
    onState: (state: string) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let reported = 'RequestCreated'
      let ticks = 0
      let checking = false
      const poll = setInterval(async () => {
        const state = this.sessionStates.get(sessionId)
        if (state && state !== reported) {
          reported = state
          onState(state)
        }
        if (state === 'ResponseVerified') {
          clearInterval(poll)
          resolve()
          return
        }
        if (Date.now() > deadline) {
          clearInterval(poll)
          reject(new AuthorizationDenied(NO_PRESENTATION_IN_TIME, deniedResult(sessionId, NO_PRESENTATION_IN_TIME)))
          return
        }
        if (++ticks % 6 === 0 && !checking) {
          checking = true
          try {
            const session = await this.identityService.getVerificationSession(sessionId)
            if (session.state) this.sessionStates.set(sessionId, session.state)
          } catch {
            // Transient; the next tick tries again and the deadline still bounds the wait.
          } finally {
            checking = false
          }
        }
      }, 500)
    })
  }
```

- [ ] **Step 6: Verify**

Run: `yarn typecheck && yarn prettier --check src/agent/index.ts && grep -n "verifiedSessions" src/agent/index.ts`
Expected: typecheck clean, prettier clean, grep prints nothing.

- [ ] **Step 7: Commit**

```bash
git add src/agent/index.ts
git -c core.safecrlf=false commit -m "feat(agent): forward the session's progress and the verified presentation to the client

Each Heka state change becomes a working update carrying authorizationStatus; completed carries
authorizationResult built from the presented token and the status check; a denial carries the same
with the reason. The agent's own timeout is the expiresAt the client counts down from.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The authorization server answers session and presentation

**Files:**

- Modify: `src/mcp/auth-server.ts` (imports; `beginAuthorization`; `completeAuthorization` → `pollAuthorization`; `GET /authorize`; `GET /authorize/:requestId`)

**Interfaces:**

- Produces on the wire: `GET /authorize` → `{ requestId, interaction, authorizationRequest, session: { id, state }, requested, message }`; `GET /authorize/:id` → `{ status: 'pending', session }` | `{ status: 'granted', code, redirectTo, presentation }` | `403 { error: 'access_denied', error_description, presentation? }`.
- Produces in code: `AuthorizationPoll` union (below).

- [ ] **Step 1: Imports**

Add after the `presented-credential` import:

```ts
import { authorizedResult, deniedResult, requestedFromDefinition } from '../shared/authorization-result'
import { InTaskOpenId4VpAuthorizationResult, InTaskOpenId4VpRequested } from '../agent/extension'
```

After `OFFICER_PRESENTATION_DEFINITION` add:

```ts
/** The definition in plain fields for the client (demo addition, mirrored from the A2A extension). */
const OFFICER_REQUESTED = requestedFromDefinition(OFFICER_PRESENTATION_DEFINITION)

export type AuthorizationPoll =
  | { state: 'pending'; session: { id: string; state: string } }
  | { state: 'granted'; code: string; redirectTo: string; presentation: InTaskOpenId4VpAuthorizationResult }
  | { state: 'denied'; reason: string; presentation: InTaskOpenId4VpAuthorizationResult }
```

- [ ] **Step 2: `beginAuthorization` returns the session and what is asked**

Change its return type and `return` to:

```ts
  }): Promise<{
    requestId: string
    authorizationRequest: string
    session: { id: string; state: string }
    requested: InTaskOpenId4VpRequested
  }> {
    …
    console.log(`[as] authorization ${requestId.slice(0, 8)} awaiting a presentation`)
    return {
      requestId,
      authorizationRequest: session.authorizationRequest,
      session: { id: session.verificationSession.id, state: session.verificationSession.state },
      requested: OFFICER_REQUESTED,
    }
  }
```

- [ ] **Step 3: Replace `completeAuthorization` with `pollAuthorization`**

Replace the whole method (doc comment included) with:

```ts
  /**
   * Answer a poll: how far the wallet has got, or the decision.
   *
   * Heka confirms the presentation is sound; whose credential it is, of what type, and whether
   * it is still live is this server's decision (src/shared/presented-credential.ts). Skipping
   * that would make the officer credential's revocation meaningless on this path.
   */
  public async pollAuthorization(requestId: string): Promise<AuthorizationPoll> {
    const authorization = this.pending.get(requestId)
    if (!authorization) throw new Error('unknown or expired authorization request')

    const trustedIssuer = loadState().issuerDid
    if (!trustedIssuer) {
      this.pending.delete(requestId)
      throw new Error('no trusted issuer configured — run `yarn seed`')
    }

    const session = await this.identityService.getVerificationSession(authorization.verificationSessionId)
    // "Not yet" is a normal poll result and the request stays open; the client learns how far the wallet got.
    if (session.state !== 'ResponseVerified') {
      return { state: 'pending', session: { id: session.id, state: session.state } }
    }

    // Possibly unset in the catch: a refusal logs the status pointer only when one was read.
    let presented: PresentedCredential | undefined
    let status: StatusCheck
    try {
      presented = readPresentedCredential(session)
      status = await assertPresentedCredentialValid(
        presented,
        {
          trustedIssuers: [trustedIssuer],
          requiredVct: ROLE_CREDENTIAL_VCT,
          statusListOrigin: this.identityService.baseOrigin,
          credentialLabel: OFFICER_CREDENTIAL.role,
          requiredClaims: { role: OFFICER_CREDENTIAL.role },
        },
        fetch
      )
    } catch (error) {
      if (!(error instanceof PresentationRefused)) throw error
      // A refusal is a decision: the request is over, so a later poll cannot re-ask and get a different answer.
      this.pending.delete(requestId)
      if (error.reason === 'revoked' && presented?.credentialStatus) {
        const { statusListIndex, statusListCredential } = presented.credentialStatus
        console.log(`[as] status checked: index ${statusListIndex} on ${statusListCredential} -> revoked`)
      }
      if (error.reason === 'foreign-status-list' && presented?.credentialStatus) {
        const origin = statusListOriginOf(presented.credentialStatus) ?? '(not a URL)'
        console.log(`[as] status list origin ${origin} is not ${this.identityService.baseOrigin}`)
      }
      console.log(`[as] authorization ${requestId.slice(0, 8)} refused (${error.reason}): ${error.message}`)
      return {
        state: 'denied',
        reason: error.message,
        presentation: deniedResult(session.id, error.message, presented, error.reason),
      }
    }

    const { role, org } = presented.claims
    if (typeof role !== 'string' || typeof org !== 'string') {
      this.pending.delete(requestId)
      const reason = 'the presentation did not disclose role and org'
      return { state: 'denied', reason, presentation: deniedResult(session.id, reason, presented) }
    }
    const claims = { role, org }

    const code = randomUUID()
    this.codes.set(code, { authorization, presented, status, claims })
    this.pending.delete(requestId)

    const redirectTo = new URL(authorization.redirectUri)
    redirectTo.searchParams.set('code', code)
    redirectTo.searchParams.set('iss', ISSUER) // RFC 9207
    if (authorization.state) redirectTo.searchParams.set('state', authorization.state)

    console.log(`[as] authorization ${requestId.slice(0, 8)} granted to ${claims.role}`)
    return {
      state: 'granted',
      code,
      redirectTo: redirectTo.toString(),
      presentation: authorizedResult(presented, status),
    }
  }
```

- [ ] **Step 4: The routes**

In `GET /authorize`, destructure and answer:

```ts
      const { requestId, authorizationRequest, session, requested } = await as.beginAuthorization({ … })

      res.json({
        requestId,
        interaction: 'openid4vp',
        authorizationRequest,
        // Demo additions, mirrored from the A2A extension: where the wallet is, and what is asked.
        session,
        requested,
        message: `Present a ${OFFICER_CREDENTIAL.role} credential to authorize scope "${scope ?? SUPPLIERS_EXPORT_SCOPE}"`,
      })
```

Replace the whole `GET /authorize/:requestId` handler with:

```ts
/** Poll: how far has the wallet got, and may we have the code? */
app.get('/authorize/:requestId', async (req, res) => {
  if (!as.getPending(req.params.requestId)) {
    res.status(404).json({ error: 'invalid_request', error_description: 'unknown authorization request' })
    return
  }

  try {
    const poll = await as.pollAuthorization(req.params.requestId)
    if (poll.state === 'pending') {
      res.json({ status: 'pending', session: poll.session })
      return
    }
    if (poll.state === 'denied') {
      res.status(403).json({ error: 'access_denied', error_description: poll.reason, presentation: poll.presentation })
      return
    }
    res.json({ status: 'granted', code: poll.code, redirectTo: poll.redirectTo, presentation: poll.presentation })
  } catch (error) {
    // Anything unexpected — Heka unreachable, no trust anchor — fails closed, as before.
    res.status(403).json({ error: 'access_denied', error_description: (error as Error).message })
  }
})
```

- [ ] **Step 5: Verify**

Run: `yarn typecheck && yarn prettier --check src/mcp/auth-server.ts && grep -n "completeAuthorization\|no verified presentation yet" src/mcp/auth-server.ts`
Expected: clean; grep prints nothing.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/auth-server.ts
git -c core.safecrlf=false commit -m "feat(as): answer polls with the session's state and the verified presentation

The poll used to say pending or granted and nothing else; now it forwards where the wallet is and,
on a decision, the same presentation shape the agent emits, so the Trust Lens shows one card for
both protocols. Denials carry the refused credential's issuer and status, never its claims.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The Trust Lens model — `presentation.ts` and `TaskTracker`

**Files:**

- Create: `src/web/presentation.ts`
- Modify: `src/web/tasks.ts` (whole file)
- Test: `src/web/__tests__/presentation.test.ts`, `src/web/__tests__/tasks.test.ts`

**Interfaces:**

- Produces: `PresentationSource`, `AuthorizationState`, `AuthorizationView { request; clientId?; sessionId?; state; expiresAt?; requested?; delivery?; source? }`, `PresentationView extends InTaskOpenId4VpAuthorizationResult { source }`, `toAuthorizationState(sessionState): AuthorizationState`, `presentationFrom(result, source?)`, `sourceOf(authorization, result)`.
- Produces: `TrackedTask { id; resource; state; startedAt; events; a2a?; preflight?; authorization?; presentation?; result?; error? }`, `applyStatusUpdate(task, update): { text?: string }`, `TaskTracker.list(): TrackedTask[]` (newest first), `TaskTracker.awaitingPresentation(task): boolean`, `sendToWallet` sets `source = 'wallet'`, `simulatePresentation` sets `source = 'simulated'`.

- [ ] **Step 1: Write the failing tests**

Create `src/web/__tests__/presentation.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { presentationFrom, sourceOf, toAuthorizationState } from '../presentation'

describe('toAuthorizationState', () => {
  it('maps the three Heka states the strip shows and treats anything else as still requested', () => {
    expect(toAuthorizationState('RequestCreated')).toBe('requested')
    expect(toAuthorizationState('RequestUriRetrieved')).toBe('wallet-fetched')
    expect(toAuthorizationState('ResponseVerified')).toBe('verified')
    expect(toAuthorizationState('Error')).toBe('requested')
  })
})

describe('sourceOf', () => {
  const authorized = { sessionId: 's', outcome: 'authorized' as const, vpToken: 'ey…' }
  const timedOut = { sessionId: 's', outcome: 'denied' as const, reason: 'no presentation was received in time' }

  it('keeps what the Trust Lens recorded when a button was pressed', () => {
    expect(sourceOf({ request: 'openid4vp://', state: 'verified', source: 'wallet' }, authorized)).toBe('wallet')
    expect(sourceOf({ request: 'openid4vp://', state: 'verified', source: 'simulated' }, authorized)).toBe('simulated')
  })

  it('infers a scan when a token arrived and nothing was pressed', () => {
    expect(sourceOf({ request: 'openid4vp://', state: 'verified' }, authorized)).toBe('qr')
  })

  it('is unknown when nothing was presented at all', () => {
    expect(sourceOf({ request: 'openid4vp://', state: 'requested' }, timedOut)).toBe('unknown')
    expect(sourceOf(undefined, timedOut)).toBe('unknown')
  })
})

describe('presentationFrom', () => {
  it('attaches the source to the relying party’s result', () => {
    expect(presentationFrom({ sessionId: 's', outcome: 'authorized' }, 'qr')).toEqual({
      sessionId: 's',
      outcome: 'authorized',
      source: 'qr',
    })
  })
})
```

Create `src/web/__tests__/tasks.test.ts`:

```ts
import { TaskStatusUpdateEvent } from '@a2a-js/sdk'
import { describe, expect, it } from 'vitest'

import { IN_TASK_OID4VP_EXTENSION_URI, InTaskOpenId4VpMessageMetadata } from '../../agent/extension'
import { applyStatusUpdate, TrackedTask } from '../tasks'

const REQUESTED = {
  purpose: 'Authorize the export',
  credentialType: 'urn:heka:role-credential:v1',
  claims: ['role', 'org'],
}

function update(
  state: TaskStatusUpdateEvent['status']['state'],
  text: string,
  metadata?: InTaskOpenId4VpMessageMetadata
): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId: 'agent-task',
    contextId: 'agent-context',
    final: state === 'completed' || state === 'failed',
    status: {
      state,
      timestamp: '2026-09-28T10:00:00.000Z',
      message: {
        kind: 'message',
        role: 'agent',
        messageId: 'm1',
        parts: [{ kind: 'text', text }],
        ...(metadata ? { metadata: { [IN_TASK_OID4VP_EXTENSION_URI]: metadata } } : {}),
      },
    },
  }
}

const fresh = (): TrackedTask => ({
  id: 't1',
  resource: 'Acme Invoice Agent',
  state: 'submitted',
  startedAt: '2026-09-28T09:59:59.000Z',
  events: [],
})

const authRequired = () =>
  update('auth-required', 'Present a credential.', {
    authorizationRequest: { client_id: 'did:key:verifier', request_uri: 'openid4vp://?request_uri=x' },
    authorizationStatus: {
      sessionId: 'sess-1',
      state: 'RequestCreated',
      expiresAt: '2026-09-28T10:03:00.000Z',
      requested: REQUESTED,
    },
  })

describe('applyStatusUpdate', () => {
  it('opens the authorization from auth-required with what is asked and when it expires', () => {
    const task = fresh()
    applyStatusUpdate(task, authRequired())

    expect(task.state).toBe('auth-required')
    expect(task.events).toHaveLength(1)
    expect(task.authorization).toEqual({
      request: 'openid4vp://?request_uri=x',
      clientId: 'did:key:verifier',
      sessionId: 'sess-1',
      state: 'requested',
      expiresAt: '2026-09-28T10:03:00.000Z',
      requested: REQUESTED,
    })
  })

  it('moves the state on each working update and infers a scan when nothing was pressed', () => {
    const task = fresh()
    applyStatusUpdate(task, authRequired())
    applyStatusUpdate(
      task,
      update('working', 'The wallet fetched the request.', {
        authorizationStatus: {
          sessionId: 'sess-1',
          state: 'RequestUriRetrieved',
          expiresAt: 'x',
          requested: REQUESTED,
        },
      })
    )

    expect(task.authorization?.state).toBe('wallet-fetched')
    expect(task.authorization?.source).toBe('qr')
  })

  it('keeps the source the Trust Lens set', () => {
    const task = fresh()
    applyStatusUpdate(task, authRequired())
    task.authorization!.source = 'wallet'
    applyStatusUpdate(
      task,
      update('working', 'Presentation verified; checking the credential’s status.', {
        authorizationStatus: { sessionId: 'sess-1', state: 'ResponseVerified', expiresAt: 'x', requested: REQUESTED },
      })
    )

    expect(task.authorization).toMatchObject({ state: 'verified', source: 'wallet' })
  })

  it('settles as authorized with the presentation on completed', () => {
    const task = fresh()
    applyStatusUpdate(task, authRequired())
    task.authorization!.source = 'simulated'
    applyStatusUpdate(
      task,
      update('completed', 'Payment export prepared.', {
        authorizationResult: {
          sessionId: 'sess-1',
          outcome: 'authorized',
          claims: { role: 'Finance Data Officer' },
          vpToken: 'ey',
        },
      })
    )

    expect(task.result).toBe('Payment export prepared.')
    expect(task.authorization?.state).toBe('authorized')
    expect(task.presentation).toMatchObject({
      outcome: 'authorized',
      source: 'simulated',
      claims: { role: 'Finance Data Officer' },
    })
  })

  it('settles as denied with the refused presentation on failed', () => {
    const task = fresh()
    applyStatusUpdate(task, authRequired())
    applyStatusUpdate(
      task,
      update('failed', 'Authorization denied: revoked', {
        authorizationResult: { sessionId: 'sess-1', outcome: 'denied', reason: 'revoked', vpToken: 'ey' },
      })
    )

    expect(task.error).toBe('Authorization denied: revoked')
    expect(task.authorization?.state).toBe('denied')
    expect(task.presentation).toMatchObject({ outcome: 'denied', source: 'qr' })
  })

  it('settles as expired when the agent gave up waiting', () => {
    const task = fresh()
    applyStatusUpdate(task, authRequired())
    applyStatusUpdate(
      task,
      update('failed', 'Authorization denied: no presentation was received in time', {
        authorizationResult: { sessionId: 'sess-1', outcome: 'denied', reason: 'no presentation was received in time' },
      })
    )

    expect(task.authorization?.state).toBe('expired')
    expect(task.presentation?.source).toBe('unknown')
  })

  it('leaves a task without the extension untouched beyond state and events', () => {
    const task = fresh()
    applyStatusUpdate(task, update('working', 'Reconciling…'))
    expect(task.authorization).toBeUndefined()
    expect(task.events[0]).toEqual({ at: '2026-09-28T10:00:00.000Z', state: 'working', text: 'Reconciling…' })
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `yarn vitest run src/web`
Expected: FAIL — `Cannot find module '../presentation'`; `applyStatusUpdate` is not exported.

- [ ] **Step 3: Create `src/web/presentation.ts`**

```ts
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
```

- [ ] **Step 4: Rewrite `src/web/tasks.ts`**

```ts
/**
 * A2A engagement, from the orchestrator's side.
 *
 * Streams a task with the agent and keeps the progress so the UI can poll it. When the agent
 * pauses in `auth-required`, the OID4VP request it carries is surfaced for the operator — pushed
 * to Heka Wallet over DIDComm, shown as a QR, or handed to the in-process simulated holder — and
 * everything the agent says about the presentation afterwards (demo additions to the extension,
 * see src/agent/extension.ts) is kept on the task and in the audit.
 */

import { A2AClient } from '@a2a-js/sdk/client'
import { Message, MessageSendParams, Task, TaskStatusUpdateEvent } from '@a2a-js/sdk'
import { randomUUID } from 'node:crypto'

import { AuditLog } from '../core/audit'
import { IdentityServiceClient } from '../shared/identity-service'
import { NO_PRESENTATION_IN_TIME } from '../shared/authorization-result'
import { SimulatedWallet } from '../shared/simulated-wallet'
import { IN_TASK_OID4VP_EXTENSION_URI, InTaskOpenId4VpMessageMetadata } from '../agent/extension'
import { AuthorizationView, presentationFrom, PresentationView, sourceOf, toAuthorizationState } from './presentation'
import { DeliveryState, deliverToWallet } from './wallet-delivery'

export interface TaskEvent {
  at: string
  state: string
  text?: string
}

export interface TrackedTask {
  id: string
  resource: string
  state: string
  startedAt: string
  events: TaskEvent[]
  /** The agent's own identifiers, from the first stream event. */
  a2a?: { taskId: string; contextId: string }
  /** The verification the Trust Lens ran at engagement time — the verdict the browser held is never trusted. */
  preflight?: { verdict: string; auditId: string; verifiedAt: string }
  /** From `auth-required` on; its state follows the verifier session, then the outcome. */
  authorization?: AuthorizationView
  /** What was verified (or refused), with the source only this side knows. */
  presentation?: PresentationView
  result?: string
  error?: string
}

const FINAL_STATES = ['authorized', 'denied', 'expired']

function extensionMetadata(update: TaskStatusUpdateEvent): InTaskOpenId4VpMessageMetadata | undefined {
  return update.status.message?.metadata?.[IN_TASK_OID4VP_EXTENSION_URI] as InTaskOpenId4VpMessageMetadata | undefined
}

/**
 * Fold one status update into the task. Pure — the audit side effects live in `consume` — and
 * exported so the folding can be tested without an agent.
 */
export function applyStatusUpdate(task: TrackedTask, update: TaskStatusUpdateEvent): { text?: string } {
  const text = update.status.message?.parts
    ?.filter((part) => part.kind === 'text')
    .map((part) => (part as { text: string }).text)
    .join(' ')

  task.state = update.status.state
  task.events.push({ at: update.status.timestamp ?? new Date().toISOString(), state: update.status.state, text })

  const metadata = extensionMetadata(update)
  const status = metadata?.authorizationStatus
  const result = metadata?.authorizationResult

  if (update.status.state === 'auth-required' && metadata?.authorizationRequest) {
    task.authorization = {
      request: metadata.authorizationRequest.request_uri,
      clientId: metadata.authorizationRequest.client_id,
      sessionId: status?.sessionId,
      state: status ? toAuthorizationState(status.state) : 'requested',
      expiresAt: status?.expiresAt,
      requested: status?.requested,
    }
  } else if (status && task.authorization && !FINAL_STATES.includes(task.authorization.state)) {
    task.authorization.state = toAuthorizationState(status.state)
    // The wallet moved and nobody pressed Send or Simulate here: the request was scanned.
    if (task.authorization.state !== 'requested' && !task.authorization.source) task.authorization.source = 'qr'
  }

  if (update.status.state === 'completed') {
    task.result = text
    if (task.authorization) task.authorization.state = 'authorized'
    if (result) task.presentation = presentationFrom(result, sourceOf(task.authorization, result))
  }

  if (update.status.state === 'failed') {
    task.error = text
    if (task.authorization) {
      task.authorization.state = result?.reason === NO_PRESENTATION_IN_TIME ? 'expired' : 'denied'
    }
    if (result) task.presentation = presentationFrom(result, sourceOf(task.authorization, result))
  }

  return { text }
}

export class TaskTracker {
  private readonly tasks = new Map<string, TrackedTask>()
  private wallet: SimulatedWallet | undefined

  public constructor(
    private readonly agentUrl: string,
    private readonly audit: AuditLog,
    private readonly identityService: IdentityServiceClient
  ) {}

  public get(id: string): TrackedTask | undefined {
    return this.tasks.get(id)
  }

  /** Newest first, like the audit: the engagement you just started is the one you look for. */
  public list(): TrackedTask[] {
    return [...this.tasks.values()].reverse()
  }

  /** True while the operator can still present against this task. */
  public awaitingPresentation(
    task: TrackedTask | undefined
  ): task is TrackedTask & { authorization: AuthorizationView } {
    return Boolean(task?.authorization && !FINAL_STATES.includes(task.authorization.state))
  }

  public async start(resource: string, prompt: string, preflight?: TrackedTask['preflight']): Promise<TrackedTask> {
    const client = new A2AClient(this.agentUrl)
    const task: TrackedTask = {
      id: randomUUID(),
      resource,
      state: 'submitted',
      startedAt: new Date().toISOString(),
      events: [],
      preflight,
    }
    this.tasks.set(task.id, task)

    const message: Message = {
      messageId: randomUUID(),
      kind: 'message',
      role: 'user',
      parts: [{ kind: 'text', text: prompt }],
    }

    // Consume the stream in the background; the UI polls this task.
    void this.consume(client, { message } as MessageSendParams, task)
    return task
  }

  private async consume(client: A2AClient, params: MessageSendParams, task: TrackedTask): Promise<void> {
    try {
      for await (const event of client.sendMessageStream(params)) {
        if (event.kind === 'task') {
          const agentTask = event as Task
          task.state = agentTask.status.state
          task.a2a = { taskId: agentTask.id, contextId: agentTask.contextId }
          continue
        }
        if (event.kind !== 'status-update') continue

        const update = event as TaskStatusUpdateEvent
        const { text } = applyStatusUpdate(task, update)
        const state = update.status.state

        if (state === 'auth-required') {
          this.audit.record('authorization', task.resource, 'authorization requested', {
            step: text,
            via: 'OID4VP In-Task Auth extension',
            sessionId: task.authorization?.sessionId,
          })
        }

        // The presentation is the evidence: it goes into the audit with the decision it settled.
        if (state === 'completed') {
          this.audit.record(
            'authorization',
            task.resource,
            'task completed after verified presentation',
            task.presentation ? { presentation: task.presentation } : undefined
          )
        }

        if (state === 'failed') {
          this.audit.record(
            'denial',
            task.resource,
            text ?? 'task failed',
            task.presentation ? { presentation: task.presentation } : undefined
          )
        }
      }
    } catch (error) {
      task.state = 'failed'
      task.error = (error as Error).message
      this.audit.record('denial', task.resource, task.error)
    }
  }

  /** Push the pending request to the operator's wallet; the outcome is kept on the task. */
  public async sendToWallet(
    task: TrackedTask & { authorization: AuthorizationView },
    deliver: (content: string) => Promise<void>
  ): Promise<DeliveryState> {
    const { authorization } = task
    authorization.source = 'wallet'
    authorization.delivery = await deliverToWallet({
      subject: task.resource,
      content: authorization.request,
      deliver,
      audit: this.audit,
      previous: authorization.delivery,
    })
    return authorization.delivery
  }

  /** Present the officer credential against any OID4VP request — the agent's or the AS's. */
  public async presentToAuthorizationServer(authorizationRequest: string): Promise<void> {
    if (!this.wallet) this.wallet = new SimulatedWallet(this.identityService)
    await this.wallet.initialize()
    await this.wallet.present(authorizationRequest)
  }

  public async simulatePresentation(task: TrackedTask & { authorization: AuthorizationView }): Promise<void> {
    // Set before presenting: the agent's next update may land before `present` returns.
    task.authorization.source = 'simulated'
    await this.presentToAuthorizationServer(task.authorization.request)

    this.audit.record('authorization', task.resource, 'presentation submitted (simulated holder)', {
      note: 'in-process holder, not the operator’s phone',
    })
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `yarn vitest run src/web && yarn prettier --check src/web/presentation.ts src/web/tasks.ts src/web/__tests__/*.ts`
Expected: all pass, prettier clean. `yarn typecheck` now fails in `src/web/server.ts` (`authorizationRequest` no longer exists) — that is Task 6's job.

- [ ] **Step 6: Commit**

```bash
git add src/web/presentation.ts src/web/tasks.ts src/web/__tests__/presentation.test.ts src/web/__tests__/tasks.test.ts
git -c core.safecrlf=false commit -m "feat(web): keep the authorization's progress and the presentation on the task

One view model for both paths. The source (wallet, QR, simulated) is decided on this side of the
protocol — the relying party cannot tell a phone from the in-process holder — and travels into the
audit with the presentation, so completion and denial entries carry the evidence they rested on.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `McpClient` owns the pending step-up and returns the presentation

**Files:**

- Modify: `src/web/mcp-client.ts` (whole file)
- Test: `src/web/__tests__/mcp-client.test.ts`

**Interfaces:**

- Produces: `PendingAuthorization` gains `session?: { id; state }`, `requested?`, `source?: PresentationSource`, `startedAt: string`; `McpClient(serverUrl, fetchFn = fetch)`; `McpClient.pending: PendingAuthorization | undefined`; `beginAuthorization(outcome)` returns the existing pending entry for the same scope and resource; `completeAuthorization(): Promise<AuthorizationPoll>` where `AuthorizationPoll { granted: boolean; session?; presentation?: PresentationView }`; `AuthorizationDeniedError { presentation?: PresentationView }`.

- [ ] **Step 1: Write the failing test**

Create `src/web/__tests__/mcp-client.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import { AuthorizationDeniedError, McpClient } from '../mcp-client'

const MCP = 'http://mcp.test'
const AS = 'http://as.test'
const REQUESTED = {
  purpose: 'Authorize export',
  credentialType: 'urn:heka:role-credential:v1',
  claims: ['role', 'org'],
}
const PRESENTATION = {
  sessionId: 'sess-1',
  outcome: 'authorized' as const,
  claims: { role: 'Finance Data Officer', org: 'TrustCo' },
  vpToken: 'ey',
}

const reply = (status: number, body: unknown) => ({
  ok: status < 400,
  status,
  headers: new Headers(),
  json: async () => body,
})

/** An AS whose poll answers are scripted; everything else is the fixed discovery chain. */
function fakeFetch(polls: Array<[number, unknown]>) {
  const authorizeCalls: string[] = []
  const fetchFn = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url === `${MCP}/.well-known/oauth-protected-resource`) {
      return reply(200, { resource: MCP, authorization_servers: [AS] })
    }
    if (url === `${AS}/.well-known/oauth-authorization-server`) {
      return reply(200, { authorization_endpoint: `${AS}/authorize`, token_endpoint: `${AS}/token` })
    }
    if (url.startsWith(`${AS}/authorize?`)) {
      authorizeCalls.push(url)
      return reply(200, {
        requestId: `req-${authorizeCalls.length}`,
        authorizationRequest: 'openid4vp://?request_uri=x',
        session: { id: 'sess-1', state: 'RequestCreated' },
        requested: REQUESTED,
      })
    }
    if (url.startsWith(`${AS}/authorize/`)) {
      const [status, body] = polls.shift() ?? [200, { status: 'pending' }]
      return reply(status, body)
    }
    if (url === `${AS}/token`) return reply(200, { access_token: 'tok', expires_in: 300 })
    throw new Error(`unexpected fetch ${url}`)
  })
  return { fetchFn: fetchFn as unknown as typeof fetch, authorizeCalls }
}

const refused = { status: 401, ok: false, body: {}, requiredScope: 'suppliers:export' }

describe('McpClient step-up', () => {
  it('starts one authorization and reuses it while it is pending for the same scope and resource', async () => {
    const { fetchFn, authorizeCalls } = fakeFetch([])
    const client = new McpClient(MCP, fetchFn)

    const first = await client.beginAuthorization(refused)
    const second = await client.beginAuthorization(refused)

    expect(authorizeCalls).toHaveLength(1)
    expect(second).toBe(first)
    expect(client.pending).toMatchObject({
      requestId: 'req-1',
      session: { id: 'sess-1', state: 'RequestCreated' },
      requested: REQUESTED,
      scope: 'suppliers:export',
    })
  })

  it('reports the session state while pending', async () => {
    const { fetchFn } = fakeFetch([
      [200, { status: 'pending', session: { id: 'sess-1', state: 'RequestUriRetrieved' } }],
    ])
    const client = new McpClient(MCP, fetchFn)
    await client.beginAuthorization(refused)

    const poll = await client.completeAuthorization()

    expect(poll).toEqual({ granted: false, session: { id: 'sess-1', state: 'RequestUriRetrieved' } })
    expect(client.pending?.session).toEqual({ id: 'sess-1', state: 'RequestUriRetrieved' })
  })

  it('exchanges the code on granted, returns the presentation with the source, and forgets the pending entry', async () => {
    const { fetchFn } = fakeFetch([
      [200, { status: 'granted', code: 'c1', redirectTo: 'x', presentation: PRESENTATION }],
    ])
    const client = new McpClient(MCP, fetchFn)
    const pending = await client.beginAuthorization(refused)
    pending.source = 'simulated'

    const poll = await client.completeAuthorization()

    expect(poll.granted).toBe(true)
    expect(poll.presentation).toEqual({ ...PRESENTATION, source: 'simulated' })
    expect(client.tokenStatus.present).toBe(true)
    expect(client.pending).toBeUndefined()
  })

  it('infers a scan when granted with nothing pressed', async () => {
    const { fetchFn } = fakeFetch([
      [200, { status: 'granted', code: 'c1', redirectTo: 'x', presentation: PRESENTATION }],
    ])
    const client = new McpClient(MCP, fetchFn)
    await client.beginAuthorization(refused)

    expect((await client.completeAuthorization()).presentation?.source).toBe('qr')
  })

  it('throws a denial carrying the refused presentation and forgets the pending entry', async () => {
    const denied = { sessionId: 'sess-1', outcome: 'denied' as const, reason: 'revoked', vpToken: 'ey' }
    const { fetchFn } = fakeFetch([
      [403, { error: 'access_denied', error_description: 'revoked', presentation: denied }],
    ])
    const client = new McpClient(MCP, fetchFn)
    await client.beginAuthorization(refused)

    const error = await client.completeAuthorization().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AuthorizationDeniedError)
    expect((error as AuthorizationDeniedError).message).toBe('revoked')
    expect((error as AuthorizationDeniedError).presentation).toEqual({ ...denied, source: 'qr' })
    expect(client.pending).toBeUndefined()
  })

  it('refuses to poll when nothing is pending', async () => {
    const client = new McpClient(MCP, fakeFetch([]).fetchFn)
    await expect(client.completeAuthorization()).rejects.toThrow('no authorization is in progress')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn vitest run src/web/__tests__/mcp-client.test.ts`
Expected: FAIL — `AuthorizationDeniedError` is not exported; constructor ignores `fetchFn`.

- [ ] **Step 3: Rewrite `src/web/mcp-client.ts`**

```ts
/**
 * The orchestrator's MCP client, including the step-up authorization flow.
 *
 * It walks the discovery chain the MCP spec defines and nothing else:
 *
 *   call tool → 401/403 with WWW-Authenticate
 *             → RFC 9728 protected resource metadata (which AS guards this?)
 *             → RFC 8414 authorization server metadata (how do I talk to it?)
 *             → authorization with PKCE + RFC 8707 resource
 *             → [the AS asks for a credential presentation]
 *             → token → retry
 *
 * Note what is absent: any knowledge of verifiable credentials. The client sees an ordinary
 * OAuth interaction it cannot complete on its own, so it surfaces it to the operator. That the
 * interaction happens to be an OID4VP presentation is entirely the authorization server's
 * business — which is the whole argument for composing them this way.
 *
 * What the AS says about the presentation afterwards (`session`, `presentation`) is a demo
 * addition mirrored from the A2A extension; the client passes it through for display and audit.
 */

import { createHash, randomBytes } from 'node:crypto'

import { InTaskOpenId4VpAuthorizationResult, InTaskOpenId4VpRequested } from '../agent/extension'
import { presentationFrom, PresentationSource, PresentationView } from './presentation'
import { DeliveryState } from './wallet-delivery'

export interface ToolCallOutcome {
  status: number
  ok: boolean
  body: unknown
  /** Set when the server refused and named a scope we could step up to. */
  requiredScope?: string
  resourceMetadataUrl?: string
}

export interface PendingAuthorization {
  requestId: string
  authorizationRequest: string
  authorizeUrl: string
  codeVerifier: string
  redirectUri: string
  resource: string
  scope: string
  startedAt: string
  message?: string
  /** Where the verifier session is, as last reported by the AS (demo addition). */
  session?: { id: string; state: string }
  /** What the AS asks for, in plain fields (demo addition). */
  requested?: InTaskOpenId4VpRequested
  /** Which way the operator chose to present — known only on this side. */
  source?: PresentationSource
  /** Last attempt to push the request to the operator's wallet, if any. */
  delivery?: DeliveryState
}

export interface AuthorizationPoll {
  granted: boolean
  session?: { id: string; state: string }
  presentation?: PresentationView
}

/** The AS refused: a revoked or untrusted credential arrives here, with what was refused when known. */
export class AuthorizationDeniedError extends Error {
  public constructor(
    message: string,
    public readonly presentation?: PresentationView
  ) {
    super(message)
    this.name = 'AuthorizationDeniedError'
  }
}

const REDIRECT_URI = 'http://localhost:4000/oauth/callback'
const CLIENT_ID = 'trust-lens'

function parseChallenge(header: string | null): Record<string, string> {
  if (!header) return {}
  const params: Record<string, string> = {}
  for (const match of header.matchAll(/(\w+)="([^"]*)"/g)) params[match[1]] = match[2]
  return params
}

export class McpClient {
  private accessToken?: string
  private tokenExpiresAt = 0
  private pendingAuthorization?: PendingAuthorization

  public constructor(
    private readonly serverUrl: string,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  public get tokenStatus(): { present: boolean; expiresInSeconds: number } {
    const remaining = Math.max(0, Math.round((this.tokenExpiresAt - Date.now()) / 1000))
    return { present: Boolean(this.accessToken) && remaining > 0, expiresInSeconds: remaining }
  }

  /** The step-up in progress, if any. One at a time: a second Invoke joins it rather than orphaning it. */
  public get pending(): PendingAuthorization | undefined {
    return this.pendingAuthorization
  }

  public forgetToken(): void {
    this.accessToken = undefined
    this.tokenExpiresAt = 0
  }

  public async listTools(): Promise<Record<string, unknown>> {
    const response = await this.fetchFn(`${this.serverUrl}/tools`)
    return (await response.json()) as Record<string, unknown>
  }

  public async callTool(name: string): Promise<ToolCallOutcome> {
    const headers: Record<string, string> = {}
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      headers.authorization = `Bearer ${this.accessToken}`
    }

    const response = await this.fetchFn(`${this.serverUrl}/tools/${name}`, { method: 'POST', headers })
    const body = await response.json().catch(() => ({}))

    if (response.ok) return { status: response.status, ok: true, body }

    const challenge = parseChallenge(response.headers.get('www-authenticate'))
    return {
      status: response.status,
      ok: false,
      body,
      requiredScope: challenge.scope,
      resourceMetadataUrl: challenge.resource_metadata,
    }
  }

  /**
   * Begin a step-up: discover the AS, then start an authorization the operator must satisfy.
   * A step-up already pending for the same scope and resource is returned as is — the AS would
   * otherwise accumulate requests nobody will ever answer.
   */
  public async beginAuthorization(outcome: ToolCallOutcome): Promise<PendingAuthorization> {
    const metadataUrl = outcome.resourceMetadataUrl ?? `${this.serverUrl}/.well-known/oauth-protected-resource`
    const resourceMetadata = (await (await this.fetchFn(metadataUrl)).json()) as {
      resource: string
      authorization_servers: string[]
    }
    const scope = outcome.requiredScope ?? 'suppliers:export'

    const pending = this.pendingAuthorization
    if (pending && pending.scope === scope && pending.resource === resourceMetadata.resource) return pending

    const authorizationServer = resourceMetadata.authorization_servers[0]
    const asMetadata = (await (
      await this.fetchFn(`${authorizationServer}/.well-known/oauth-authorization-server`)
    ).json()) as { authorization_endpoint: string; token_endpoint: string }

    // PKCE: the verifier never leaves this process.
    const codeVerifier = randomBytes(32).toString('base64url')
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')

    const authorizeUrl = new URL(asMetadata.authorization_endpoint)
    authorizeUrl.searchParams.set('client_id', CLIENT_ID)
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI)
    authorizeUrl.searchParams.set('code_challenge', codeChallenge)
    authorizeUrl.searchParams.set('code_challenge_method', 'S256')
    authorizeUrl.searchParams.set('scope', scope)
    // RFC 8707 — bind the token to this resource, so it is useless anywhere else.
    authorizeUrl.searchParams.set('resource', resourceMetadata.resource)

    const started = (await (await this.fetchFn(authorizeUrl.toString())).json()) as {
      requestId: string
      authorizationRequest: string
      message?: string
      session?: { id: string; state: string }
      requested?: InTaskOpenId4VpRequested
    }

    this.pendingAuthorization = {
      requestId: started.requestId,
      authorizationRequest: started.authorizationRequest,
      authorizeUrl: authorizeUrl.origin,
      codeVerifier,
      redirectUri: REDIRECT_URI,
      resource: resourceMetadata.resource,
      scope,
      startedAt: new Date().toISOString(),
      message: started.message,
      session: started.session,
      requested: started.requested,
    }
    return this.pendingAuthorization
  }

  /**
   * Ask the AS whether the presentation has landed. `granted: false` while still waiting (with
   * the session's state); throws `AuthorizationDeniedError` when the AS refuses (a revoked
   * credential arrives here). Any outcome other than "still waiting" ends the pending step-up.
   */
  public async completeAuthorization(): Promise<AuthorizationPoll> {
    const pending = this.pendingAuthorization
    if (!pending) throw new Error('no authorization is in progress')

    try {
      return await this.poll(pending)
    } catch (error) {
      this.pendingAuthorization = undefined
      throw error
    }
  }

  private async poll(pending: PendingAuthorization): Promise<AuthorizationPoll> {
    const response = await this.fetchFn(`${pending.authorizeUrl}/authorize/${pending.requestId}`)
    const body = (await response.json()) as {
      status?: string
      code?: string
      error_description?: string
      session?: { id: string; state: string }
      presentation?: InTaskOpenId4VpAuthorizationResult
    }

    // A token that arrived with nothing pressed on this side was scanned from the QR.
    const source = pending.source ?? 'qr'

    if (response.status === 403) {
      throw new AuthorizationDeniedError(
        body.error_description ?? 'authorization denied',
        body.presentation && presentationFrom(body.presentation, source)
      )
    }
    if (body.status !== 'granted' || !body.code) {
      if (body.session) pending.session = body.session
      return { granted: false, session: pending.session }
    }

    const tokenResponse = await this.fetchFn(`${pending.authorizeUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: body.code,
        code_verifier: pending.codeVerifier,
        redirect_uri: pending.redirectUri,
        resource: pending.resource,
      }),
    })

    const token = (await tokenResponse.json()) as {
      access_token?: string
      expires_in?: number
      error_description?: string
    }
    if (!token.access_token) throw new Error(token.error_description ?? 'token request failed')

    this.accessToken = token.access_token
    this.tokenExpiresAt = Date.now() + (token.expires_in ?? 300) * 1000
    this.pendingAuthorization = undefined
    return {
      granted: true,
      session: body.session ?? pending.session,
      presentation: body.presentation && presentationFrom(body.presentation, source),
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `yarn vitest run src/web/__tests__/mcp-client.test.ts && yarn prettier --check src/web/mcp-client.ts src/web/__tests__/mcp-client.test.ts`
Expected: 6 tests pass; prettier clean.

- [ ] **Step 5: Commit**

```bash
git add src/web/mcp-client.ts src/web/__tests__/mcp-client.test.ts
git -c core.safecrlf=false commit -m "feat(web): one pending step-up at a time, and the AS's presentation passed through

The client owns the pending authorization: a second Invoke for the same scope and resource joins it
instead of starting another the AS would never see answered (ENHANCEMENTS §3). Polls report the
session's state; a grant or a denial carries the presentation with the source only this side knows.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The routes

**Files:**

- Modify: `src/web/server.ts` (imports; `/api/config`; `/api/task/:id` neighbours; `GET /api/tasks`; all `/api/mcp/*` routes)

**Interfaces:**

- Produces: `GET /api/config` gains `trustedIssuerName`; `GET /api/tasks` → `{ tasks: [{ id, resource, state, startedAt, a2a, presentation?: { outcome, claims, source } }] }`; `POST /api/mcp/call` → `authorization: { request, message, scope, resource, session, requested, source, delivery }`; `GET /api/mcp/authorization` → `{ granted, token, delivery, session, presentation }` or `403 { error, presentation }` or `409`.

- [ ] **Step 1: Imports and config**

Replace `import { McpClient, PendingAuthorization } from './mcp-client'` with `import { AuthorizationDeniedError, McpClient } from './mcp-client'`. Replace `import { ACME_DOMAIN, PRO_DOMAIN } from '../shared/demo-config'` with `import { ACME_DOMAIN, PRO_DOMAIN, TRUSTCO } from '../shared/demo-config'`. Delete the line `let pendingAuthorization: PendingAuthorization | undefined`.

In `/api/config` add `trustedIssuerName: TRUSTCO.name,` after `trustedIssuers`.

- [ ] **Step 2: Task routes**

After `app.get('/api/task/:id', …)` add:

```ts
/** Every engagement this process has seen, newest first — enough for a list; open one for the rest. */
app.get('/api/tasks', (_req, res) => {
  res.json({
    tasks: tasks.list().map(({ id, resource, state, startedAt, a2a, presentation }) => ({
      id,
      resource,
      state,
      startedAt,
      a2a,
      presentation: presentation && {
        outcome: presentation.outcome,
        claims: presentation.claims,
        source: presentation.source,
      },
    })),
  })
})
```

In `POST /api/task/:id/send-to-wallet` and `POST /api/task/:id/simulate-presentation`, replace `if (!task?.authorizationRequest) {` with `if (!tasks.awaitingPresentation(task)) {` (the type guard narrows `task` for the calls below).

- [ ] **Step 3: MCP routes**

Replace `POST /api/mcp/call`'s step-up tail (from `pendingAuthorization = await mcp.beginAuthorization(outcome)` through the `res.json({ … })`) with:

```ts
const pending = await mcp.beginAuthorization(outcome)
res.json({
  ok: false,
  status: outcome.status,
  requiredScope: outcome.requiredScope,
  authorization: {
    request: pending.authorizationRequest,
    message: pending.message,
    scope: pending.scope,
    resource: pending.resource,
    session: pending.session,
    requested: pending.requested,
    source: pending.source,
    delivery: pending.delivery,
  },
})
```

Replace the three routes `/api/mcp/send-to-wallet`, `/api/mcp/simulate-presentation`, `/api/mcp/authorization` with:

```ts
/** Push the AS's OID4VP request to the operator's phone over DIDComm. */
app.post('/api/mcp/send-to-wallet', async (_req, res) => {
  const pending = mcp.pending
  if (!pending) {
    res.status(409).json({ error: 'no authorization is in progress' })
    return
  }
  if (!walletLink.status.linked) {
    res.status(409).json({ error: 'no wallet linked — paste the wallet’s Public DID first' })
    return
  }

  pending.source = 'wallet'
  pending.delivery = await deliverToWallet({
    subject: `MCP · ${pending.scope}`,
    content: pending.authorizationRequest,
    deliver: (content) => walletLink.send(content),
    audit,
    previous: pending.delivery,
  })
  res.status(pending.delivery.state === 'sent' ? 200 : 502).json({ delivery: pending.delivery })
})

/**
 * Present the officer credential to the AS from the in-process holder. Labelled as simulated in
 * the UI and in the audit, exactly as the A2A route is — who presented is the subject of the demo.
 */
app.post('/api/mcp/simulate-presentation', async (_req, res) => {
  const pending = mcp.pending
  if (!pending) {
    res.status(409).json({ error: 'no authorization is in progress' })
    return
  }

  try {
    // Set before presenting: the next poll may land before `present` returns.
    pending.source = 'simulated'
    await tasks.presentToAuthorizationServer(pending.authorizationRequest)
    audit.record('authorization', `MCP · ${pending.scope}`, 'presentation submitted (simulated holder)', {
      note: 'in-process holder, not the operator’s phone',
    })
    res.json({ ok: true })
  } catch (error) {
    res.status(500).json({ error: (error as Error).message })
  }
})

/** Poll the AS, exchange the code, and report whether a token was obtained — and against what. */
app.get('/api/mcp/authorization', async (_req, res) => {
  const pending = mcp.pending
  if (!pending) {
    res.status(409).json({ error: 'no authorization is in progress' })
    return
  }

  try {
    const poll = await mcp.completeAuthorization()
    if (poll.granted) {
      audit.record('authorization', `MCP · ${pending.scope}`, 'scoped token issued against a verified presentation', {
        ttlSeconds: mcp.tokenStatus.expiresInSeconds,
        resource: pending.resource,
        presentation: poll.presentation,
      })
    }
    res.json({
      granted: poll.granted,
      token: mcp.tokenStatus,
      delivery: pending.delivery,
      session: poll.session,
      presentation: poll.presentation,
    })
  } catch (error) {
    const message = (error as Error).message
    const presentation = error instanceof AuthorizationDeniedError ? error.presentation : undefined
    audit.record('denial', `MCP · ${pending.scope}`, message, presentation ? { presentation } : undefined)
    res.status(403).json({ error: message, presentation })
  }
})
```

- [ ] **Step 4: Verify**

Run: `yarn typecheck && yarn test && yarn prettier --check src/web/server.ts && grep -n "pendingAuthorization\|authorizationRequest" src/web/server.ts`
Expected: clean; grep shows only `pending.authorizationRequest` uses (no `pendingAuthorization`, no `task.authorizationRequest`).

- [ ] **Step 5: Commit**

```bash
git add src/web/server.ts
git -c core.safecrlf=false commit -m "feat(web): expose tasks, the step-up's session and the presentation; label the MCP simulation

GET /api/tasks lists engagements; the MCP routes read the pending step-up from the client, record
the simulated holder as the A2A route does (invariant 7), and every grant or denial entry carries
the presentation it rested on.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The UI — Tasks tab, pollers, steps, countdowns, presentation card, Raw VP

**Files:**

- Modify: `src/web/public/ui.js` (add `renderEvidence`), `src/console/public/console.js` (use it)
- Modify: `src/web/public/index.html` (whole file)
- Modify: `src/web/public/app.js` (whole file)
- Modify: `src/web/public/app.css` (append a section)

**Interfaces:**

- Consumes: Task 6's JSON shapes.
- Produces: `ui.renderEvidence(evidence, omit = [])` → `.kv.compact` HTML of the scalar entries.

- [ ] **Step 1: Move `renderEvidence` into `ui.js`**

In `src/web/public/ui.js`, before `return { el, … }` add:

```js
/** Scalar evidence as key/value rows; nested objects (a presentation, say) are rendered by the caller. */
function renderEvidence(evidence, omit = []) {
  if (!evidence || typeof evidence !== 'object') return ''
  const rows = Object.entries(evidence)
    .filter(([key, value]) => value !== undefined && typeof value !== 'object' && !omit.includes(key))
    .map(([key, value]) => `<div><span>${escapeHtml(key)}</span><code>${escapeHtml(String(value))}</code></div>`)
    .join('')
  return rows ? `<div class="kv compact">${rows}</div>` : ''
}
```

and export it: `return { el, escapeHtml, renderQr, formatWhen, renderWalletChip, copyText, renderEvidence }`.

In `src/console/public/console.js` delete the local `function renderEvidence(evidence) { … }` and change its one call to `${ui.renderEvidence(event.evidence)}`.

- [ ] **Step 2: Rewrite `src/web/public/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Trust Lens</title>
    <link rel="stylesheet" href="./app.css" />
  </head>
  <body>
    <header>
      <div class="brand">
        <h1>Trust Lens</h1>
        <p class="subtitle">Discovery is a phone book. Credentials are what vouch.</p>
      </div>
      <div class="wallet" id="wallet">
        <span class="badge" id="wallet-chip">wallet: not linked</span>
        <input
          id="wallet-did"
          type="text"
          placeholder="did:peer:2… (the wallet’s Public DID)"
          aria-label="Wallet public DID"
        />
        <button id="wallet-link">Link wallet</button>
        <button id="wallet-unlink" hidden>Unlink</button>
        <span class="error" id="wallet-error"></span>
      </div>
      <nav>
        <button class="tab active" data-view="discovery">Discovery</button>
        <button class="tab" data-view="tasks">Tasks</button>
        <button class="tab" data-view="mcp">MCP tools</button>
        <button class="tab" data-view="audit">Audit</button>
      </nav>
    </header>

    <main>
      <section id="discovery" class="view active">
        <form id="search-form">
          <input id="query" type="search" value="Acme invoice" aria-label="Search resources" />
          <button type="submit">Search</button>
          <button type="button" id="verify-all" disabled>Verify all</button>
        </form>

        <p id="score-note" class="note"></p>

        <div id="results" class="cards"></div>
        <p id="empty" class="empty">Search the registry to discover published resources.</p>
      </section>

      <section id="tasks" class="view">
        <h2>Engagements</h2>
        <p class="note">Every task started with an agent, newest first, and who authorized its sensitive step.</p>
        <div id="tasks-list" class="cards"></div>
        <p id="tasks-empty" class="empty">No agent engaged yet — verify a resource on Discovery and press Engage.</p>
      </section>

      <section id="task" class="view">
        <button id="task-back" class="tab">&larr; Back to tasks</button>
        <h2 id="task-title"></h2>
        <p class="note" id="task-context"></p>

        <ol id="task-events" class="timeline"></ol>

        <div id="task-auth" class="auth-panel" hidden>
          <h3 id="task-auth-title">Authorization required</h3>
          <p class="note">
            The agent has paused. It needs a Finance Data Officer credential presented over OID4VP before it will
            prepare the payment export — role and organisation only, nothing else.
          </p>
          <div class="asked" id="task-asked"></div>
          <ol class="steps" id="task-steps"></ol>
          <p class="countdown" id="task-countdown"></p>
          <div class="auth-ways" id="task-ways">
            <div class="auth-way">
              <h4>Send to the operator’s phone</h4>
              <p class="note">
                A DIDComm message to the linked Heka Wallet. The person taps <strong>Share</strong> there.
              </p>
              <button id="task-send" class="auth-primary" data-send="task">Send to wallet</button>
              <div class="delivery" id="task-delivery"></div>
            </div>
            <div class="auth-way">
              <h4>Or scan with Heka Wallet</h4>
              <div class="qr" id="task-qr" role="img" aria-label="OID4VP request QR code"></div>
              <div class="uri"><code id="task-uri"></code><button data-copy="task-uri">Copy</button></div>
            </div>
            <div class="auth-way auth-secondary">
              <h4>Or, without a phone</h4>
              <button id="task-simulate">Simulate presentation (demo)</button>
              <p class="note" id="task-simulate-note"></p>
            </div>
          </div>
        </div>

        <div id="task-presentation"></div>
        <pre id="task-result" class="result" hidden></pre>
      </section>

      <section id="mcp" class="view">
        <h2>Acme Invoice Data — MCP tools</h2>
        <p class="note">
          The same credential, a second protocol. Routine data flows freely; the sensitive tool demands a scope, and the
          scope is only granted against a verified presentation.
          <span id="token-status" class="badge"></span>
          <button id="token-drop" hidden>Drop token</button>
        </p>
        <p class="mcp-engaged" id="mcp-engaged" hidden></p>

        <div id="tools" class="cards"></div>

        <div id="mcp-auth" class="auth-panel" hidden>
          <h3 id="mcp-auth-title">Authorization required</h3>
          <p class="note" id="mcp-auth-message"></p>
          <div class="asked" id="mcp-asked"></div>
          <ol class="steps" id="mcp-steps"></ol>
          <p class="countdown" id="mcp-countdown"></p>
          <div class="auth-ways" id="mcp-ways">
            <div class="auth-way">
              <h4>Send to the operator’s phone</h4>
              <p class="note">
                A DIDComm message to the linked Heka Wallet. The person taps <strong>Share</strong> there.
              </p>
              <button id="mcp-send" class="auth-primary" data-send="mcp">Send to wallet</button>
              <div class="delivery" id="mcp-delivery"></div>
            </div>
            <div class="auth-way">
              <h4>Or scan with Heka Wallet</h4>
              <div class="qr" id="mcp-qr" role="img" aria-label="OID4VP request QR code"></div>
              <div class="uri"><code id="mcp-uri"></code><button data-copy="mcp-uri">Copy</button></div>
            </div>
            <div class="auth-way auth-secondary">
              <h4>Or, without a phone</h4>
              <button id="mcp-simulate">Simulate presentation (demo)</button>
              <p class="note" id="mcp-simulate-note"></p>
            </div>
          </div>
        </div>

        <div id="mcp-presentation"></div>
        <pre id="mcp-result" class="result" hidden></pre>
      </section>

      <section id="audit" class="view">
        <h2>Trust decisions</h2>
        <p class="note">Every verification, refusal and revocation, with the evidence behind it.</p>
        <ol id="audit-list" class="timeline"></ol>
      </section>
    </main>

    <div id="backdrop" class="backdrop" hidden></div>

    <aside id="drawer" class="drawer" hidden>
      <button id="drawer-close" class="close" aria-label="Close">&times;</button>
      <h2 id="drawer-title"></h2>
      <p id="drawer-verdict"></p>
      <div id="drawer-body"></div>
    </aside>

    <script src="./vendor/qrcode-generator.js"></script>
    <script src="./ui.js"></script>
    <script src="./app.js"></script>
  </body>
</html>
```

- [ ] **Step 3: Rewrite `src/web/public/app.js`**

```js
/* Trust Lens UI. Deliberately dependency-free (one vendored QR encoder): the interesting part is the trust model. */

const state = {
  results: [],
  verdicts: new Map(),
  wallet: { linked: false },
  config: { trustedIssuers: [], trustedIssuerName: '' },
  taskId: null,
}

const { el, escapeHtml } = ui

const VERDICT_CLASS = { VERIFIED: 'ok' }
const badgeClass = (verdict) => VERDICT_CLASS[verdict] ?? (verdict ? 'bad' : '')
const isAgent = (result) => result.type.includes('a2a')
const FINAL_STATES = ['authorized', 'denied', 'expired']
const shorten = (value, head = 24, tail = 6) =>
  value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value
const mmss = (seconds) =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`

async function loadConfig() {
  const response = await fetch('/api/config')
  if (response.ok) state.config = await response.json()
}

// ---------- polling that survives navigation ----------

// A tab switch used to clear every interval, which killed a pending task the moment you looked
// away. A poller now runs until its own work is final, whatever view is visible.
const pollers = new Map()

function startPoller(key, tick, ms) {
  stopPoller(key)
  pollers.set(key, setInterval(tick, ms))
  tick()
}

function stopPoller(key) {
  clearInterval(pollers.get(key))
  pollers.delete(key)
}

// ---------- operator's wallet ----------

async function loadWallet() {
  const response = await fetch('/api/wallet')
  state.wallet = response.ok ? await response.json() : { linked: false }
  renderWallet()
}

function renderWallet() {
  ui.renderWalletChip(
    { chipId: 'wallet-chip', inputId: 'wallet-did', linkId: 'wallet-link', unlinkId: 'wallet-unlink' },
    state.wallet
  )
  // The send buttons depend on the link; re-render whichever panel is open.
  renderSendButton('task')
  renderSendButton('mcp')
}

async function linkWallet() {
  const holderDid = el('wallet-did').value.trim()
  el('wallet-error').textContent = ''
  el('wallet-link').disabled = true
  el('wallet-link').textContent = 'Linking…'

  try {
    const response = await fetch('/api/wallet/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ holderDid }),
    })
    const data = await response.json()
    if (!response.ok) {
      el('wallet-error').textContent = data.error
      return
    }
    state.wallet = data
    renderWallet()
  } finally {
    el('wallet-link').disabled = false
    el('wallet-link').textContent = 'Link wallet'
  }
}

async function unlinkWallet() {
  const response = await fetch('/api/wallet/link', { method: 'DELETE' })
  state.wallet = response.ok ? await response.json() : { linked: false }
  renderWallet()
}

// ---------- discovery ----------

async function search(query) {
  const response = await fetch(`/api/discovery?q=${encodeURIComponent(query)}`)
  const data = await response.json()

  state.results = data.results ?? []
  state.verdicts.clear()

  el('score-note').textContent = state.results.length ? `Score: ${data.scoreMeaning}` : ''
  el('verify-all').disabled = state.results.length === 0
  render()
}

function render() {
  const container = el('results')
  el('empty').hidden = state.results.length > 0

  container.innerHTML = state.results
    .map((result) => {
      const verdict = state.verdicts.get(result.identifier)
      const badge = verdict
        ? `<span class="badge ${badgeClass(verdict.verdict)}">${escapeHtml(verdict.verdict)}</span>`
        : `<span class="badge">Not verified</span>`

      const engageable = verdict?.engageable
      const actions = verdict
        ? `<div class="actions">
             <button data-details="${escapeHtml(result.identifier)}">Evidence</button>
             <button data-engage="${escapeHtml(result.identifier)}" ${engageable ? '' : 'disabled'}>Engage</button>
           </div>
           ${engageable ? '' : '<span class="refusal">refused: not verified</span>'}`
        : ''

      const kind = isAgent(result) ? 'A2A agent' : 'MCP server'

      return `
        <article class="card ${verdict && !engageable ? 'refused' : ''}">
          <div>
            <h3>${escapeHtml(result.displayName)}</h3>
            <div class="meta">
              <span class="chip">${escapeHtml(kind)}</span>
              <span>${escapeHtml(result.publisher)}</span>
              ${result.hasAttestation ? '' : '<span class="chip">no attestation</span>'}
            </div>
          </div>
          <div class="right">
            ${badge}
            <span class="score">relevance ${result.score}</span>
            ${actions}
          </div>
          <p class="desc">${escapeHtml(result.description ?? '')}</p>
        </article>`
    })
    .join('')
}

async function verifyAll() {
  const button = el('verify-all')
  button.disabled = true
  button.textContent = 'Verifying…'

  try {
    const response = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifiers: state.results.map((r) => r.identifier) }),
    })
    const data = await response.json()
    for (const result of data.results ?? []) state.verdicts.set(result.identifier, result)
    render()
  } finally {
    button.textContent = 'Verify all'
    button.disabled = false
  }
}

// ---------- evidence drawer ----------

const CHECKS = [
  ['urnPublisherFqdn', 'URN publisher matches the serving domain'],
  ['didResolved', 'Identity resolves on Hedera'],
  ['digestValid', 'Attestation matches the digest in the catalog'],
  ['signatureValid', 'Credential signature is valid'],
  ['validityWindowOk', 'Credential is within its validity window'],
  ['issuerTrusted', 'Issued by a trusted anchor'],
  ['subjectBinding', 'Credential subject is this resource'],
  ['operatorDomain', 'Attested operator domain matches the publisher'],
  ['cardDigestValid', 'Resource card matches its passport'],
  ['statusLive', 'Not revoked'],
]

function checkState(key, evidence, verdict) {
  switch (key) {
    case 'urnPublisherFqdn':
      return evidence.urnPublisherFqdn === evidence.servingDomain
    case 'subjectBinding':
      return verdict === 'SUBJECT_MISMATCH' ? false : evidence.subjectDid ? true : undefined
    case 'operatorDomain':
      return verdict === 'OPERATOR_DOMAIN_MISMATCH' ? false : evidence.operatorDomain ? true : undefined
    case 'statusLive':
      if (evidence.statusListChecked === false) return false
      return evidence.statusRevoked === undefined ? undefined : !evidence.statusRevoked
    default:
      return evidence[key]
  }
}

function openDrawer(identifier) {
  const result = state.results.find((r) => r.identifier === identifier)
  const verdict = state.verdicts.get(identifier)
  if (!result || !verdict) return

  const evidence = verdict.evidence ?? {}

  el('drawer-title').textContent = result.displayName
  el('drawer-verdict').innerHTML =
    `<span class="badge ${badgeClass(verdict.verdict)}">${escapeHtml(verdict.verdict)}</span>`

  const checks = CHECKS.map(([key, label]) => {
    const value = checkState(key, evidence, verdict.verdict)
    const mark = value === true ? ['ok', '✓'] : value === false ? ['bad', '✕'] : ['skip', '–']
    return `<li><span class="mark ${mark[0]}">${mark[1]}</span><span>${escapeHtml(label)}</span></li>`
  }).join('')

  const rows = [
    ['Operator', evidence.operatorLegalName],
    ['Operator domain', evidence.operatorDomain],
    ['Publisher', evidence.servingDomain],
    ['Resource identity', evidence.identity],
    ['Credential subject', evidence.subjectDid],
    ['Issuer', evidence.issuerDid],
    ['Attestation', evidence.attestationUri],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `<div><span>${escapeHtml(label)}</span><code>${escapeHtml(value)}</code></div>`)
    .join('')

  el('drawer-body').innerHTML = `
    <ul class="checks">${checks}</ul>
    ${evidence.failureDetail ? `<div class="failure">${escapeHtml(evidence.failureDetail)}</div>` : ''}
    <div class="kv">${rows}</div>`

  setDrawerOpen(true)
}

function setDrawerOpen(open) {
  el('drawer').hidden = !open
  el('backdrop').hidden = !open
}

// ---------- the presentation card and the Raw VP drawer ----------

// Presentations shown anywhere on the page, by session id, so a Raw VP button can find its token.
const presentations = new Map()

const SOURCE_LABEL = {
  wallet: ['Heka Wallet (DIDComm)', 'ok'],
  qr: ['QR scan', 'ok'],
  simulated: ['Simulated holder (demo)', 'warn'],
  unknown: ['unknown', ''],
}

function issuerNote(issuer) {
  const trusted = (state.config.trustedIssuers ?? []).includes(issuer)
  return trusted ? `(${state.config.trustedIssuerName || 'trusted issuer'}, trusted)` : '(not a trusted issuer)'
}

function presentationCard(presentation, compact = false) {
  if (!presentation) return ''
  if (presentation.sessionId) presentations.set(presentation.sessionId, presentation)

  const denied = presentation.outcome === 'denied'
  const status = presentation.status
  const [sourceLabel, sourceTone] = SOURCE_LABEL[presentation.source] ?? SOURCE_LABEL.unknown
  const claims = Object.entries(presentation.claims ?? {})
    .map(([name, value]) => `<span class="chip">${escapeHtml(name)} · ${escapeHtml(String(value))}</span>`)
    .join(' ')
  const statusText = status
    ? `${status.revoked ? 'revoked' : 'live'} · index ${status.statusListIndex} · checked ${ui.formatWhen(status.checkedAt)}`
    : 'not checked'
  const code = (value) => `<code title="${escapeHtml(value)}">${escapeHtml(shorten(value))}</code>`

  const rows = [
    !denied && claims && ['Claims', claims],
    presentation.credentialType && ['Credential', `<code>${escapeHtml(presentation.credentialType)}</code>`],
    presentation.issuer && [
      'Issuer',
      `${code(presentation.issuer)} <span class="note">${escapeHtml(issuerNote(presentation.issuer))}</span>`,
    ],
    presentation.holder && ['Holder', code(presentation.holder)],
    [
      'Status',
      `<span class="${status?.revoked ? 'text-bad' : status ? 'text-ok' : ''}">${escapeHtml(statusText)}</span>`,
    ],
    presentation.sessionId && ['Session', `<code>${escapeHtml(presentation.sessionId.slice(0, 8))}</code>`],
    presentation.verifiedAt && ['Verified', escapeHtml(ui.formatWhen(presentation.verifiedAt))],
    ['Presented via', `<span class="badge ${sourceTone}">${escapeHtml(sourceLabel)}</span>`],
  ]
    .filter(Boolean)
    .map(([label, html]) => `<div><span>${escapeHtml(label)}</span><span>${html}</span></div>`)
    .join('')

  return `
    <article class="card presentation ${denied ? 'refused' : ''} ${compact ? 'compact' : ''}">
      <div>
        <h3>${denied ? 'Presentation refused' : 'Verified presentation'}</h3>
        ${denied ? `<p class="refusal">${escapeHtml(presentation.reason ?? '')}</p>` : ''}
      </div>
      <div class="right">
        <span class="badge ${denied ? 'bad' : 'ok'}">${denied ? 'DENIED' : 'AUTHORIZED'}</span>
        ${presentation.vpToken ? `<button data-raw-vp="${escapeHtml(presentation.sessionId ?? '')}">Raw VP</button>` : ''}
      </div>
      <div class="kv compact">${rows}</div>
    </article>`
}

/** base64url → JSON, in the browser; the disclosures are ASCII but the values need not be. */
function decodeSegment(segment) {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

function decodeJwtPayload(compact) {
  try {
    return decodeSegment(compact.split('.')[1])
  } catch {
    return { error: 'could not decode' }
  }
}

function openRawVp(presentation) {
  if (!presentation?.vpToken) return
  const segments = presentation.vpToken.split('~')
  const issuerJwt = segments[0]
  // Compact form: issuer-jwt ~ disclosure ~ … ~ [kb-jwt]; a trailing "~" means no key binding.
  const keyBinding = segments[segments.length - 1] || undefined
  const encoded = segments.slice(1, keyBinding ? -1 : undefined).filter(Boolean)
  const disclosures = encoded.map((segment) => {
    try {
      const [salt, name, value] = decodeSegment(segment)
      return { salt, name, value }
    } catch {
      return { salt: '?', name: '(undecodable)', value: segment }
    }
  })

  el('drawer-title').textContent = 'Raw verifiable presentation'
  el('drawer-verdict').innerHTML = `<span class="badge">compact SD-JWT · ${disclosures.length} disclosure${
    disclosures.length === 1 ? '' : 's'
  }${keyBinding ? ' · key binding' : ''}</span>`

  const rows = disclosures
    .map(
      (d) =>
        `<div><span>${escapeHtml(d.name ?? '(array element)')}</span><code>${escapeHtml(
          JSON.stringify(d.value)
        )} <span class="note">salt ${escapeHtml(d.salt)}</span></code></div>`
    )
    .join('')

  el('drawer-body').innerHTML = `
    <h3 class="raw-heading">Disclosures</h3>
    <div class="kv">${rows || '<div><span>none</span><span></span></div>'}</div>
    <h3 class="raw-heading">Issuer JWT payload</h3>
    <pre class="raw">${escapeHtml(JSON.stringify(decodeJwtPayload(issuerJwt), null, 2))}</pre>
    ${
      keyBinding
        ? `<h3 class="raw-heading">Key binding JWT payload</h3>
    <pre class="raw">${escapeHtml(JSON.stringify(decodeJwtPayload(keyBinding), null, 2))}</pre>`
        : ''
    }
    <h3 class="raw-heading">Compact token</h3>
    <pre class="raw">${escapeHtml(presentation.vpToken)}</pre>`

  setDrawerOpen(true)
}

// ---------- authorization panel (shared by the task view and the MCP view) ----------

// `panel` is 'task' or 'mcp'; element ids are `${panel}-send`, `${panel}-qr`, and so on.
const auth = {
  task: { request: null, delivery: null, authorization: null },
  mcp: { request: null, delivery: null, authorization: null },
}

const STEPS = ['Requested', 'Wallet fetched', 'Verified', 'Status checked', 'Authorized']

/** How many steps are done. A denial after a status check has walked the whole strip. */
function stepProgress(authorization, presentation) {
  switch (authorization.state) {
    case 'wallet-fetched':
      return 2
    case 'verified':
      return 3
    case 'authorized':
      return 5
    case 'denied':
      return presentation?.status ? 4 : presentation?.vpToken ? 3 : 1
    default:
      return 1
  }
}

function renderSteps(panel, authorization, presentation) {
  const failed = authorization.state === 'denied' || authorization.state === 'expired'
  const progress = stepProgress(authorization, presentation)
  el(`${panel}-steps`).innerHTML = STEPS.map((label, index) => {
    if (index === STEPS.length - 1 && failed) {
      return `<li class="bad">${authorization.state === 'expired' ? 'Expired' : 'Denied'}</li>`
    }
    const cls = index < progress ? 'done' : index === progress && !failed ? 'current' : ''
    return `<li class="${cls}">${escapeHtml(label)}</li>`
  }).join('')
}

function renderCountdown(panel, authorization) {
  const target = el(`${panel}-countdown`)
  if (!authorization?.expiresAt || FINAL_STATES.includes(authorization.state)) {
    target.textContent = ''
    target.className = 'countdown'
    return
  }
  const left = Math.max(0, Math.round((Date.parse(authorization.expiresAt) - Date.now()) / 1000))
  target.className = `countdown ${left <= 30 ? 'bad' : ''}`
  // The agent's own timeout, not the verifier session's lifetime — that one is shorter and not exposed.
  target.textContent =
    left > 0 ? `Agent timeout in ${mmss(left)}` : 'Agent timeout expired — waiting for the agent to give up'
}

function renderAsked(panel, authorization) {
  const { requested, clientId } = authorization
  const target = el(`${panel}-asked`)
  if (!requested) {
    target.innerHTML = ''
    return
  }
  const chips = requested.claims.map((claim) => `<span class="chip">${escapeHtml(claim)}</span>`).join(' ')
  target.innerHTML = `
    <h4>What is asked</h4>
    <div class="kv compact">
      <div><span>Purpose</span><span>${escapeHtml(requested.purpose)}</span></div>
      <div><span>Credential</span><code>${escapeHtml(requested.credentialType)}</code></div>
      <div><span>Claims</span><span>${chips}</span></div>
      ${clientId ? `<div><span>Verifier</span><code title="${escapeHtml(clientId)}">${escapeHtml(shorten(clientId))}</code></div>` : ''}
    </div>`
}

function renderSendButton(panel) {
  const button = el(`${panel}-send`)
  if (!button) return
  const { linked } = state.wallet
  const { delivery } = auth[panel]
  button.disabled = !linked
  button.textContent = delivery ? 'Resend to wallet' : 'Send to wallet'
  button.title = linked ? '' : 'Link the wallet first — paste its Public DID in the header'
}

function renderDelivery(panel) {
  const { delivery } = auth[panel]
  const target = el(`${panel}-delivery`)
  if (!delivery) {
    target.className = 'delivery'
    target.textContent = state.wallet.linked
      ? ''
      : 'No wallet linked — paste its Public DID in the header, or use the other ways below.'
    return
  }
  const at = ui.formatWhen(delivery.at)
  target.className = `delivery ${delivery.state}`
  target.textContent =
    delivery.state === 'sent'
      ? `Sent ${at} · waiting for Share in Heka Wallet…`
      : `Delivery failed ${at}: ${delivery.error}`
}

function showAuthPanel(panel, authorization, presentation) {
  const changed = auth[panel].request !== authorization.request
  auth[panel].request = authorization.request
  auth[panel].authorization = authorization
  auth[panel].delivery = authorization.delivery ?? (changed ? null : auth[panel].delivery)

  if (changed) {
    ui.renderQr(el(`${panel}-qr`), authorization.request)
    el(`${panel}-uri`).textContent = authorization.request
    el(`${panel}-simulate-note`).textContent = ''
  }

  const settled = FINAL_STATES.includes(authorization.state)
  renderAsked(panel, authorization)
  renderSteps(panel, authorization, presentation)
  renderCountdown(panel, authorization)
  // Once decided there is nothing left to present; the strip and what was asked stay as the record.
  el(`${panel}-ways`).hidden = settled
  el(`${panel}-auth`).classList.toggle('settled', settled)
  el(`${panel}-auth`).classList.toggle('refused', authorization.state === 'denied' || authorization.state === 'expired')
  renderSendButton(panel)
  renderDelivery(panel)
  el(`${panel}-auth`).hidden = false
}

function hideAuthPanel(panel) {
  auth[panel] = { request: null, delivery: null, authorization: null }
  el(`${panel}-auth`).hidden = true
}

async function sendToWallet(panel) {
  const button = el(`${panel}-send`)
  button.disabled = true
  button.textContent = 'Sending…'

  try {
    const url = panel === 'task' ? `/api/task/${state.taskId}/send-to-wallet` : '/api/mcp/send-to-wallet'
    const response = await fetch(url, { method: 'POST' })
    const data = await response.json()
    auth[panel].delivery = data.delivery ?? { state: 'failed', at: new Date().toISOString(), error: data.error }
    renderDelivery(panel)
  } finally {
    renderSendButton(panel)
  }
}

// ---------- tasks ----------

const TASK_BADGE = { completed: 'ok', failed: 'bad', 'auth-required': 'warn' }

async function loadTasks() {
  const response = await fetch('/api/tasks')
  if (!response.ok) return
  const data = await response.json()
  const tasks = data.tasks ?? []

  el('tasks-empty').hidden = tasks.length > 0
  el('tasks-list').innerHTML = tasks
    .map((task) => {
      const presentation = task.presentation
      const by =
        presentation?.outcome === 'authorized' && presentation.claims
          ? `Authorized by ${presentation.claims.role ?? '?'} · ${presentation.claims.org ?? '?'}`
          : presentation?.outcome === 'denied'
            ? 'Authorization denied'
            : ''
      return `
        <article class="card ${task.state === 'failed' ? 'refused' : ''}">
          <div>
            <h3>${escapeHtml(task.resource)}</h3>
            <div class="meta">
              <span>started ${escapeHtml(ui.formatWhen(task.startedAt))}</span>
              ${task.a2a ? `<span class="chip" title="${escapeHtml(task.a2a.taskId)}">task ${escapeHtml(task.a2a.taskId.slice(0, 8))}</span>` : ''}
              ${by ? `<span>${escapeHtml(by)}</span>` : ''}
              ${presentation?.source === 'simulated' ? '<span class="chip warn">simulated</span>' : ''}
            </div>
          </div>
          <div class="right">
            <span class="badge ${TASK_BADGE[task.state] ?? ''}">${escapeHtml(task.state)}</span>
            <div class="actions"><button data-open-task="${escapeHtml(task.id)}">Open</button></div>
          </div>
        </article>`
    })
    .join('')
}

// ---------- agent task ----------

async function engage(identifier) {
  const result = state.results.find((r) => r.identifier === identifier)

  // The server re-verifies before engaging; the verdict this page holds is display only.
  const response = await fetch('/api/engage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  })
  const data = await response.json()

  if (!response.ok) {
    alert(data.verdict ? `refused: ${data.verdict} at engagement time` : data.error)
    return
  }

  // An MCP server is not engaged with a task: its tools are on the MCP tab. Going there is the
  // engagement, and the fresh verdict travels along so the tab can say what was verified.
  if (data.kind === 'mcp') {
    el('mcp-engaged').hidden = false
    el('mcp-engaged').textContent =
      `${result?.displayName ?? identifier} — re-verified ${ui.formatWhen(data.verifiedAt)} · VERIFIED (${result?.publisher ?? ''}). Verified is not the same as unlocked: the sensitive tool below still demands a scope.`
    showView('mcp')
    return
  }

  watchTask(data.taskId)
}

const AUTH_TITLE = {
  authorized: 'Authorized',
  denied: 'Authorization denied',
  expired: 'Authorization expired',
}

function renderTask(task) {
  el('task-title').textContent = task.resource
  el('task-context').textContent = task.preflight
    ? `Re-verified ${ui.formatWhen(task.preflight.verifiedAt)} · ${task.preflight.verdict} — asking it to reconcile May invoices and prepare the payment export`
    : ''

  el('task-events').innerHTML = task.events
    .map(
      (event) => `<li class="${event.state === 'failed' ? 'bad' : event.state === 'completed' ? 'ok' : ''}">
          <div class="when">${escapeHtml(event.at)} · ${escapeHtml(event.state)}</div>
          ${escapeHtml(event.text ?? '')}
        </li>`
    )
    .join('')

  if (task.authorization) {
    el('task-auth-title').textContent = AUTH_TITLE[task.authorization.state] ?? 'Authorization required'
    showAuthPanel('task', task.authorization, task.presentation)
  } else {
    hideAuthPanel('task')
  }

  el('task-presentation').innerHTML = presentationCard(task.presentation)

  const result = el('task-result')
  if (task.result || task.error) {
    result.hidden = false
    result.className = `result ${task.error ? 'bad' : ''}`
    result.textContent = task.result ?? task.error
  } else {
    result.hidden = true
  }
}

/** Open a task and keep polling it until it is final — whatever view is visible meanwhile. */
function watchTask(taskId) {
  state.taskId = taskId
  el('task-title').textContent = ''
  el('task-context').textContent = ''
  el('task-events').innerHTML = ''
  el('task-presentation').innerHTML = ''
  el('task-result').hidden = true
  hideAuthPanel('task')
  showView('task')

  startPoller(
    'task',
    async () => {
      const response = await fetch(`/api/task/${taskId}`)
      if (!response.ok) {
        stopPoller('task')
        return
      }
      const task = await response.json()
      if (state.taskId !== taskId) return
      renderTask(task)
      if (task.state === 'completed' || task.state === 'failed') stopPoller('task')
    },
    1500
  )
}

async function simulatePresentation() {
  const button = el('task-simulate')
  button.disabled = true
  el('task-simulate-note').textContent = 'Presenting…'

  try {
    const response = await fetch(`/api/task/${state.taskId}/simulate-presentation`, { method: 'POST' })
    const data = await response.json()
    el('task-simulate-note').textContent = response.ok ? 'Presented by the in-process holder.' : data.error
  } finally {
    button.disabled = false
  }
}

function showView(name) {
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === name))
  document
    .querySelectorAll('.tab[data-view]')
    .forEach((tab) => tab.classList.toggle('active', tab.dataset.view === name))

  // The list refreshes only while it is on screen; task and step-up pollers keep running regardless.
  stopPoller('tasks')
  if (name === 'tasks') startPoller('tasks', loadTasks, 3000)
  if (name === 'audit') loadAudit()
  if (name === 'mcp') {
    loadTools()
    if (mcp.pending && !pollers.has('mcp-auth')) pollAuthorization()
  }
}

// ---------- MCP tools ----------

// The step-up in progress on this page: which tool to retry, and the authorization as last polled.
const mcp = { pending: null }
const token = { expiresAt: 0 }

const SESSION_STATE = {
  RequestCreated: 'requested',
  RequestUriRetrieved: 'wallet-fetched',
  ResponseVerified: 'verified',
}

async function loadTools() {
  const response = await fetch('/api/mcp/tools')
  const data = await response.json()

  if (!response.ok) {
    el('tools').innerHTML = `<p class="note">${escapeHtml(data.error)}</p>`
    return
  }

  renderTokenStatus(data.token)

  el('tools').innerHTML = (data.tools ?? [])
    .map(
      (tool) => `
        <article class="card">
          <div>
            <h3>${escapeHtml(tool.name)}</h3>
            <div class="meta">
              ${tool.requiredScope ? `<span class="chip">scope ${escapeHtml(tool.requiredScope)}</span>` : '<span class="chip">no elevated scope</span>'}
            </div>
          </div>
          <div class="right">
            <button data-tool="${escapeHtml(tool.name)}">Invoke</button>
          </div>
          <p class="desc">${escapeHtml(tool.description)}</p>
        </article>`
    )
    .join('')
}

/** With a status from the server the deadline is reset; without one the badge just counts down. */
function renderTokenStatus(status) {
  if (status) token.expiresAt = status.present ? Date.now() + status.expiresInSeconds * 1000 : 0
  const left = Math.max(0, Math.round((token.expiresAt - Date.now()) / 1000))
  const badge = el('token-status')
  if (left > 0) {
    badge.className = `badge ${left <= 30 ? 'warn' : 'ok'}`
    badge.textContent = `token · ${mmss(left)} left`
  } else {
    badge.className = 'badge'
    badge.textContent = 'no token'
  }
  el('token-drop').hidden = left <= 0
}

function mcpAuthorizationFrom(authorization) {
  return {
    request: authorization.request,
    sessionId: authorization.session?.id,
    state: SESSION_STATE[authorization.session?.state] ?? 'requested',
    requested: authorization.requested,
    delivery: authorization.delivery,
    source: authorization.source,
  }
}

async function invokeTool(name, { retry = false } = {}) {
  el('mcp-result').hidden = true
  // A settled panel from an earlier step-up is cleared by a fresh Invoke; a live one is joined.
  if (!retry && !mcp.pending) {
    hideAuthPanel('mcp')
    el('mcp-presentation').innerHTML = ''
  }

  const response = await fetch('/api/mcp/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: name }),
  })
  const data = await response.json()

  if (data.ok) {
    el('mcp-result').hidden = false
    const by = data.result?.authorizedBy
    el('mcp-result').className = 'result'
    el('mcp-result').textContent =
      (by?.role ? `Authorized by ${by.role} · ${by.org}\n\n` : '') +
      JSON.stringify(data.result?.content ?? data.result, null, 2)
    renderTokenStatus(data.token)
    return
  }

  if (data.authorization) {
    el('mcp-auth-title').textContent =
      `${data.status === 403 ? 'Insufficient scope' : 'Authorization required'} — ${data.requiredScope}`
    el('mcp-auth-message').textContent = data.authorization.message ?? ''
    mcp.pending = { tool: name, authorization: mcpAuthorizationFrom(data.authorization) }
    showAuthPanel('mcp', mcp.pending.authorization, null)
    pollAuthorization()
    return
  }

  el('mcp-result').hidden = false
  el('mcp-result').className = 'result bad'
  el('mcp-result').textContent = data.error ?? JSON.stringify(data, null, 2)
}

function pollAuthorization() {
  if (!mcp.pending) return
  startPoller(
    'mcp-auth',
    async () => {
      if (!mcp.pending) {
        stopPoller('mcp-auth')
        return
      }
      const response = await fetch('/api/mcp/authorization')
      const data = await response.json()

      // Nothing pending on the server (a restart, say): there is nothing to wait for.
      if (response.status === 409) {
        stopPoller('mcp-auth')
        mcp.pending = null
        hideAuthPanel('mcp')
        return
      }

      if (response.status === 403) {
        stopPoller('mcp-auth')
        el('mcp-auth-title').textContent = 'Authorization denied'
        showAuthPanel('mcp', { ...mcp.pending.authorization, state: 'denied' }, data.presentation)
        el('mcp-presentation').innerHTML = presentationCard(data.presentation)
        el('mcp-result').hidden = false
        el('mcp-result').className = 'result bad'
        el('mcp-result').textContent = data.error
        mcp.pending = null
        return
      }

      if (data.granted) {
        stopPoller('mcp-auth')
        const { tool, authorization } = mcp.pending
        mcp.pending = null
        el('mcp-auth-title').textContent = 'Authorized'
        showAuthPanel('mcp', { ...authorization, state: 'authorized', delivery: data.delivery }, data.presentation)
        renderTokenStatus(data.token)
        await invokeTool(tool, { retry: true }) // step-up complete: retry the original call
        el('mcp-presentation').innerHTML = presentationCard(data.presentation)
        return
      }

      // Keep the strip and the delivery line in step with what the server saw.
      const authorization = mcp.pending.authorization
      if (data.session) {
        authorization.sessionId = data.session.id
        authorization.state = SESSION_STATE[data.session.state] ?? authorization.state
      }
      if (data.delivery) authorization.delivery = data.delivery
      showAuthPanel('mcp', authorization, null)
    },
    2000
  )
}

async function simulateMcpPresentation() {
  const button = el('mcp-simulate')
  button.disabled = true
  el('mcp-simulate-note').textContent = 'Presenting…'

  try {
    const response = await fetch('/api/mcp/simulate-presentation', { method: 'POST' })
    const data = await response.json()
    el('mcp-simulate-note').textContent = response.ok ? 'Presented by the in-process holder.' : data.error
  } finally {
    button.disabled = false
  }
}

async function dropToken() {
  const response = await fetch('/api/mcp/token', { method: 'DELETE' })
  const data = await response.json()
  renderTokenStatus(data.token)
  el('mcp-result').hidden = false
  el('mcp-result').className = 'result'
  el('mcp-result').textContent =
    'Cached token dropped. The next sensitive call has to authorize again — against the credential as it stands now.'
}

// ---------- audit ----------

async function loadAudit() {
  const response = await fetch('/api/audit')
  const data = await response.json()

  // A refusal is as much a trust decision as an approval; colour by what happened, not by type.
  const REFUSALS = ['denial', 'engagement_refused', 'revocation']
  const tone = (event) => {
    if (REFUSALS.includes(event.type)) return 'bad'
    if (event.outcome === 'VERIFIED') return 'ok'
    if (event.type === 'verification') return 'bad'
    return ''
  }

  el('audit-list').innerHTML =
    (data.events ?? [])
      .map((event) => {
        const evidence = event.evidence ?? {}
        const detail = evidence.failureDetail ?? evidence.note
        return `<li class="${tone(event)}">
          <div class="when">${escapeHtml(event.timestamp)} · ${escapeHtml(event.type)}</div>
          <strong>${escapeHtml(event.subject)}</strong> — ${escapeHtml(event.outcome)}
          ${detail ? `<div class="note">${escapeHtml(detail)}</div>` : ''}
          ${ui.renderEvidence(evidence, ['failureDetail', 'note'])}
          ${presentationCard(evidence.presentation, true)}
        </li>`
      })
      .join('') || '<li class="note">No trust decisions recorded yet.</li>'
}

// ---------- wiring ----------

el('search-form').addEventListener('submit', (event) => {
  event.preventDefault()
  search(el('query').value)
})

el('verify-all').addEventListener('click', verifyAll)
el('drawer-close').addEventListener('click', () => setDrawerOpen(false))
el('backdrop').addEventListener('click', () => setDrawerOpen(false))
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setDrawerOpen(false)
})

el('results').addEventListener('click', (event) => {
  const details = event.target.closest('[data-details]')
  if (details) return openDrawer(details.dataset.details)

  const engageTarget = event.target.closest('[data-engage]')
  if (engageTarget && !engageTarget.disabled) engage(engageTarget.dataset.engage)
})

el('wallet-link').addEventListener('click', linkWallet)
el('wallet-unlink').addEventListener('click', unlinkWallet)
el('wallet-did').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') linkWallet()
})

document.addEventListener('click', (event) => {
  const send = event.target.closest('[data-send]')
  if (send && !send.disabled) sendToWallet(send.dataset.send)

  const copy = event.target.closest('[data-copy]')
  if (copy) ui.copyText(el(copy.dataset.copy).textContent, copy)

  const raw = event.target.closest('[data-raw-vp]')
  if (raw) openRawVp(presentations.get(raw.dataset.rawVp))

  const open = event.target.closest('[data-open-task]')
  if (open) watchTask(open.dataset.openTask)
})

el('task-simulate').addEventListener('click', simulatePresentation)
el('task-back').addEventListener('click', () => showView('tasks'))

el('mcp-simulate').addEventListener('click', simulateMcpPresentation)
el('token-drop').addEventListener('click', dropToken)
el('tools').addEventListener('click', (event) => {
  const button = event.target.closest('[data-tool]')
  if (button) invokeTool(button.dataset.tool)
})

document.querySelectorAll('.tab[data-view]').forEach((tab) => {
  tab.addEventListener('click', () => showView(tab.dataset.view))
})

// One clock for everything that counts down: the agent's timeout and the token's lifetime.
setInterval(() => {
  if (auth.task.authorization) renderCountdown('task', auth.task.authorization)
  renderTokenStatus()
}, 1000)

loadConfig()
loadWallet()
search(el('query').value)
```

- [ ] **Step 4: Append to `src/web/public/app.css`**

Insert before the `/* ---------- small screens ---------- */` section:

```css
/* ---------- the presentation in the engagement ---------- */

/* What is asked, before anyone scans: a small titled block inside the amber panel. */
.asked {
  margin-top: 12px;
}

.asked h4 {
  margin: 0 0 4px;
  font-size: 13px;
}

/* The step strip: Requested → Wallet fetched → Verified → Status checked → Authorized. */
.steps {
  list-style: none;
  padding: 0;
  margin: 14px 0 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  counter-reset: step;
}

.steps li {
  counter-increment: step;
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 3px 11px 3px 6px;
  font-size: 12px;
  color: var(--muted);
}

.steps li::before {
  content: counter(step);
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: inline-grid;
  place-items: center;
  font-size: 11px;
  border: 1px solid var(--line);
}

.steps li.done {
  color: var(--ok);
  border-color: rgba(74, 222, 128, 0.45);
}

.steps li.done::before {
  content: '✓';
  border-color: rgba(74, 222, 128, 0.45);
}

.steps li.current {
  color: var(--warn);
  border-color: rgba(251, 191, 36, 0.6);
}

.steps li.bad {
  color: var(--bad);
  border-color: rgba(248, 113, 113, 0.5);
}

.steps li.bad::before {
  content: '✕';
  border-color: rgba(248, 113, 113, 0.5);
}

/* The agent's timeout. Red in the last half minute, so a slow tap is visibly about to fail. */
.countdown {
  margin: 10px 0 0;
  font-size: 12.5px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.countdown:empty {
  display: none;
}

.countdown.bad {
  color: var(--bad);
}

/* Once decided, the panel is the record, not a prompt. */
.auth-panel.settled {
  border-color: rgba(74, 222, 128, 0.4);
  background: rgba(74, 222, 128, 0.05);
}

.auth-panel.settled h3 {
  color: var(--ok);
}

.auth-panel.settled.refused {
  border-color: rgba(248, 113, 113, 0.4);
  background: rgba(248, 113, 113, 0.05);
}

.auth-panel.settled.refused h3 {
  color: var(--bad);
}

.card.presentation {
  margin-top: 16px;
}

.card.presentation .kv {
  grid-column: 1 / -1;
  margin-top: 4px;
}

.card.presentation.compact {
  margin-top: 10px;
  padding: 12px 14px;
}

.card.presentation.compact h3 {
  font-size: 14px;
}

.card.presentation .badge {
  white-space: normal;
}

.card.presentation .kv .chip {
  margin-right: 4px;
}

.chip.warn {
  color: var(--warn);
  border-color: rgba(251, 191, 36, 0.45);
}

.text-ok {
  color: var(--ok);
}

.text-bad {
  color: var(--bad);
}

/* A failed task is not a green box. */
.result.bad {
  border-color: rgba(248, 113, 113, 0.4);
}

/* Raw VP: the decoded segments and the compact token in the drawer. */
.raw-heading {
  margin: 20px 0 6px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}

.raw {
  margin: 0;
  padding: 10px 12px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  white-space: pre-wrap;
  word-break: break-all;
}
```

- [ ] **Step 5: Static checks**

Run: `node --check src/web/public/app.js && node --check src/web/public/ui.js && node --check src/console/public/console.js && yarn prettier --check src/web/public/app.js src/web/public/ui.js src/web/public/index.html src/web/public/app.css src/console/public/console.js && grep -c "renderEvidence" src/console/public/console.js`
Expected: no syntax errors, prettier clean (use `--write` if it reflows), grep prints `1`.

- [ ] **Step 6: Commit**

```bash
git add src/web/public/app.js src/web/public/ui.js src/web/public/index.html src/web/public/app.css src/console/public/console.js
git -c core.safecrlf=false commit -m "feat(ui): a Tasks tab, live steps, two countdowns and the presentation card on both paths

Pollers survive navigation; the step strip follows the verifier session; the agent's timeout and
the token's lifetime count down every second; the presentation is a card with its source badge and
a Raw VP drawer that decodes each disclosure. A failed task is red, not green.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Docs

**Files:**

- Modify: `README.md` (Flow 2 diagram and steps 5–7; Flow 3 diagram; "Open the demo" step 3)
- Modify: `docs/ARCHITECTURE.md` ("Authorization paths")
- Modify: `docs/GOAL.md` (Non-repudiation row)
- Modify: `.claude/skills/demo-walkthrough/SKILL.md` (§4, §5, §7)
- Modify: `ENHANCEMENTS.md` (§1 edited, §3 removed, table renumbered)

- [ ] **Step 1: README Flow 2**

In the Flow 2 mermaid diagram, replace the line `Agent-->>Lens: status-update auth-required<br/>metadata[extension].authorizationRequest` with:

```
    Agent-->>Lens: status-update auth-required<br/>metadata[extension].authorizationRequest<br/>+ authorizationStatus (demo addition)
```

after `HIS-->>W: signed authorization request` add:

```
    HIS-->>Agent: RequestUriRetrieved, over WebSocket
    Agent-->>Lens: status-update working "The wallet fetched the request."
```

replace `Agent-->>Lens: status-update completed + payment export` / `Lens-->>Op: result, naming who authorized it` with:

```
        Agent-->>Lens: status-update completed + payment export<br/>+ authorizationResult (demo addition)
        Lens-->>Op: result and the presentation card — claims, issuer, holder, status, source
```

and `Agent-->>Lens: status-update failed — authorization denied` with:

```
        Agent-->>Lens: status-update failed — authorization denied<br/>+ authorizationResult (outcome denied, reason)
```

Replace numbered steps 5–7 with:

```markdown
5. **Verification**: Heka validates the presentation and notifies the agent over WebSocket. Each session state on the way (`RequestUriRetrieved`, `ResponseVerified`) is forwarded to the Trust Lens as a `working` update carrying `authorizationStatus`, so the step strip moves as the person acts.
6. **Revocation check**: the agent then consults the status list itself, because Heka's verifier does not. An unreadable list means refuse.
7. **Task execution**: the export is produced, and `completed` carries `authorizationResult` — the disclosed claims, issuer, holder binding, the status check and the compact VP. The agent never learns _who_ the operator is — only that someone holding a Finance Data Officer credential approved this step, at this moment. The Trust Lens shows it as a card, keeps it on the task (the **Tasks** tab lists every engagement) and records it in the audit.

**What the client learns about the presentation (demo addition).** The v1 In-Task Auth extension defines only `authorizationRequest`; nothing after it. This demo adds `authorizationStatus` (session id, Heka state, the agent's `expiresAt`, what is asked) and `authorizationResult` (outcome, claims, issuer, holder, status check, `vpToken`) under the same metadata key, labelled as such in `src/agent/extension.ts`. They travel in-band because the client must not read the verifier's session: fetching the `request_uri` from the Trust Lens would move it to `RequestUriRetrieved` and corrupt the signal. The source of a presentation (wallet, QR, simulated) is known only to the Trust Lens and is set there.
```

- [ ] **Step 2: README Flow 3 and "Open the demo"**

In the Flow 3 diagram, replace `AS-->>Lens: interaction openid4vp + authorizationRequest` with:

```
    AS-->>Lens: interaction openid4vp + authorizationRequest<br/>+ session, requested (demo addition)
```

and `AS-->>Lens: authorization code, plus iss per RFC 9207` with:

```
    AS-->>Lens: authorization code, plus iss per RFC 9207<br/>+ presentation (demo addition); pending polls carry the session state
```

After the Flow 3 numbered list's paragraph ("The resource server never sees a credential…") add:

```markdown
The poll answers mirror the A2A extension's demo additions: `pending` carries `session { id, state }`, `granted` and a `403` denial carry `presentation` — the same shape the agent emits — so the Trust Lens renders one card for both paths. A second Invoke while a step-up is pending joins it instead of starting another.
```

In "Open the demo" step 3, after "The task completes with the payment export." add:

```markdown
The panel says what is asked and walks Requested → Wallet fetched → Verified → Status checked → Authorized as the person acts, with the agent's timeout counting down; the completed task shows a presentation card — claims, issuer, holder, status check, and how it was presented (a simulated holder is labelled) — with **Raw VP** for the compact token. The **Tasks** tab lists every engagement and reopens one; a pending task keeps running while you look elsewhere.
```

In step 4, replace "The badge shows the token's remaining lifetime; **Drop token** discards it." with "The same card appears above the bank details; the badge counts the token's lifetime down; **Drop token** discards it."

- [ ] **Step 3: `docs/ARCHITECTURE.md`**

Replace the **A2A** paragraph under "Authorization paths" with:

```markdown
**A2A** (`src/agent`) — the agent creates a verification session, returns `auth-required` carrying
the OID4VP request in `message.metadata[<extension URI>]`, forwards each session state as a
`working` update, and resumes when the session reaches `ResponseVerified` and the status check
passes. `completed` and `failed` carry what was verified. Only `authorizationRequest` is the
spec's; `authorizationStatus` and `authorizationResult` are demo additions under the same key
(`src/agent/extension.ts`), built by `src/shared/authorization-result.ts` and carried in-band
because the client never reads the verifier's session.
```

and append to the **MCP** paragraph:

```markdown
The AS's poll answers mirror the same demo additions (`session` while pending, `presentation` on a
grant or a denial). The Trust Lens folds both paths into one view (`src/web/presentation.ts`),
decides the presentation's source (wallet, QR, simulated — the relying party cannot tell), and
records the presentation with every completion, grant and denial in the audit.
```

- [ ] **Step 4: `docs/GOAL.md`**

Replace the Non-repudiation row with:

```markdown
| Non-repudiation | **Partial.** The presentation is now retained with the decision that relied on it — claims, issuer, holder, status check and the compact VP, in the task and in the audit (about 2 KB per presentation, in memory). The log is still in-process and unsigned; see [ENHANCEMENTS](../ENHANCEMENTS.md#non-repudiation) |
```

- [ ] **Step 5: `.claude/skills/demo-walkthrough/SKILL.md`**

In §4, replace "Poll `GET /api/task/<id>`. Expect `working` → `working` → **`auth-required`**, with `authorizationRequest` set." with:

```markdown
Poll `GET /api/task/<id>`. Expect `working` → `working` → **`auth-required`**, with `a2a.taskId`,
`a2a.contextId` and an `authorization` block: `state: "requested"`, `expiresAt` about 180 s ahead,
`requested.claims: ["role", "org"]`, `requested.credentialType: "urn:heka:role-credential:v1"`.
```

After "Then expect `working` → `completed` …" add:

```markdown
The events include `The wallet fetched the request.` (real wallet) and `Presentation verified;
checking the credential's status.`; the task's `presentation` has `outcome: "authorized"`,
`claims.role`, `issuer`, `holder`, `status.revoked: false`, `vpToken` and `source` —
`"simulated"` for the in-process holder, `"wallet"` after Send to wallet, `"qr"` for a scan.
`GET /api/tasks` lists every engagement, newest first.
```

In §5, replace the comment on the poll line with `# pending: session.state; granted: true, TTL ~300s, presentation.source` and add after "Expect bank details plus `authorizedBy` …":

```markdown
Invoking the sensitive tool again while a step-up is pending returns the same `authorization`
(same QR); the AS logs a single `awaiting a presentation`. With nothing pending the poll answers
`409`. The token-issued audit entry carries `evidence.presentation`; a denial carries it too.
```

In §7 add after the deliveries sentence:

```markdown
Every `task completed after verified presentation`, `scoped token issued …` and `denial` entry
carries `evidence.presentation`, with `source` saying whether a phone or the simulated holder
presented — the Audit tab renders it as a card with **Raw VP**.
```

- [ ] **Step 6: `ENHANCEMENTS.md`**

In the table remove row 3 and renumber 4–8 to 3–7. In "Non-repudiation", replace the third missing-item bullet with:

```markdown
- The verifiable presentation is now retained — claims, issuer, holder, status check and the
  compact VP travel with the decision into the audit — but only in memory, alongside the log.
```

and the "What it takes" paragraph with:

```markdown
**What it takes.** Persist the log with the presentations it already holds; sign each record with
the relying party's key so the chain can be checked later by someone who was not there. Neither is
large — `src/core/audit.ts` is already an append-only structure, so the shape is right and only the
durability and the signature are absent.
```

Delete the whole "## Finish a pending authorization instead of orphaning it" section (heading through its last paragraph, and the `---` after it).

- [ ] **Step 7: Verify and commit**

Run: `yarn prettier --check README.md docs/ARCHITECTURE.md docs/GOAL.md ENHANCEMENTS.md .claude/skills/demo-walkthrough/SKILL.md && grep -n "orphaning" ENHANCEMENTS.md`
Expected: prettier clean (`--write` reflows the table), grep prints nothing.

```bash
git add README.md docs/ARCHITECTURE.md docs/GOAL.md ENHANCEMENTS.md .claude/skills/demo-walkthrough/SKILL.md
git -c core.safecrlf=false commit -m "docs: the presentation is part of the engagement, and the demo additions are named as such

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Live validation (after the operator restarts `yarn web`, `yarn agent`, `yarn as`)

Follow the brief's "Steps to validate" 1–8 exactly, from `demo/trust-lens`. The operator does the wallet steps (PIN, Share). Record what each printed; fix and re-run anything that does not match; then tick the brief's Definition of Done boxes.
