# T3 — Integrate the VC presentation with A2A and MCP engagements in the Trust Lens UI

> Status: done (2026-09-28) · Branch: `task/03-presentation-ux` from `task/02-console-styling`
> (third in the chain; T2 must meet its DoD first) · Builds on: T1 phases A–B
> (`PresentedCredential`, `StatusCheck`), T2 phase 1 (`ui.js`) — both already in this branch · Next
> in the chain: `task/04-agent-server-view` branches from this one

## Why

The demo's thesis is _who_ authorized a sensitive step. Today the presentation is the one thing
the UI never shows: both paths render the same three-way panel (Send to wallet / QR / Simulate),
and once the step completes the A2A view shows a hard-coded sentence while the MCP view shows a
role read from a JWT that may have been filled from constants. The verified presentation is
discarded at every layer (README Flow 2 promises "result, naming who authorized it"; the code does
not deliver it). The task of making the presentation part of the engagement, on both protocols,
serves the following goals:

- the verified presentation is retained with the decision that relied on it, on both protocols
- the operator sees what is asked, how far the exchange has got, and who authorized the step
- pending work survives navigation, and one pending authorization is reused rather than orphaned
- simulation is labelled wherever a presentation is shown (invariant 7)

## Findings

- **Thrown away at every layer.** The agent reads only `session.state`
  (`src/agent/index.ts:303-304`); `TaskTracker` keeps only the request string
  (`src/web/tasks.ts:90`); the simulated wallet returns `void`; the AS reads `sharedAttributes`
  only to mint `role`/`org` with a constants fallback (`src/mcp/auth-server.ts:168-172`).
- **Nothing after completion.** A2A: `#task-result` shows the agent's text; the line "Export
  authorized by a verified Finance Data Officer presentation" is hard-coded in
  `src/agent/invoice-work.ts:30`. MCP: `Authorized by <role> · <org>` from the token.
- **No holder, no issuer, no session, no time.** No countdown for the agent's 180 s timeout
  (`AGENT_AUTH_TIMEOUT_MS`), no session expiry, the token badge is a snapshot rather than a
  countdown (`app.js:441-450`; README says "watch the TTL count down").
- **Delivery is shallow.** "Sent" means DIDComm handed the message off; Heka's
  `RequestUriRetrieved` (the wallet opened the request) is visible only in the agent log.
- **Pending state is fragile.** No Tasks tab — any tab click clears `taskPoll` and `authPoll`
  (`app.js:608-612`) and the task view cannot be reopened; a 409 from `/api/mcp/authorization`
  keeps polling silently; a second Invoke while an authorization is pending orphans the first
  (ENHANCEMENTS §4).
- **Simulation labelling is uneven (invariant 7).** A2A audits the simulated presentation
  (`tasks.ts:142-144`); `POST /api/mcp/simulate-presentation` audits nothing
  (`src/web/server.ts:342-354`); both results look identical to a real one.
- **Audit evidence is recorded but not rendered.** `loadAudit` shows only
  `failureDetail`/`note` (`app.js:550`); `authorizedBy`, `via`, `attempt`, `ttlSeconds` never
  appear.
- **The spec is silent after the request.** `v1/spec.md` defines `authorizationRequest`
  `{client_id, request_uri | request}` and nothing else. Whatever comes back is a demo addition.
- **Fetching the `request_uri` from the Trust Lens would corrupt the signal**: Credo moves the
  session to `RequestUriRetrieved` on the first fetch. The client must not dereference it; what
  is being asked has to travel in-band from the relying party.

## Scope

1. A documented demo extension of the metadata: `authorizationStatus` on the way in,
   `authorizationResult` on the way out — A2A over the extension key, MCP over the AS's poll.
2. The Trust Lens keeps the presentation (claims, issuer, holder, status check, compact VP) on
   the task / the authorization, in the audit evidence, and shows it.
3. A Tasks tab; pending work survives navigation; one pending authorization is reused rather
   than orphaned; 409 is handled.
4. Live steps (Requested → Wallet fetched → Verified → Status checked → Authorized/Denied), a
   countdown, and a real token TTL countdown.
5. Simulation labelled on both paths, in the UI and the audit.

### Non-goals

- Signing or persisting the audit log (ENHANCEMENTS §1 stays partially open).
- Changing the presentation definition (still `role` and `org`, `limit_disclosure: required`).
- Any UI for the agent's own side (T4) or an LLM (T5).

## Decisions (design review)

1. Data flows **in-band** from the relying party. The client never reads the verifier's Heka
   session (Q11).
2. Same metadata key (`IN_TASK_OID4VP_EXTENSION_URI`), three fields; `extension.ts` says which are
   spec and which are demo additions (Q26).
3. The compact VP is retained and shown (Q12); nothing is signed.
4. The Tasks tab and pending-state resilience belong here (Q13).
5. The presentation card shows: claims · credential type · issuer · holder binding · status
   check · session id · verified at · source (wallet / QR / simulated) · Raw VP (Q27). The source
   is known only to the Trust Lens (the relying party cannot tell a simulated holder from a
   phone), so it is set client-side and travels into the audit.

## Plan

### Phase 1 — the contract (`src/agent/extension.ts`, AS response shapes)

```ts
/** Spec (v1): carried on `auth-required`. */
export interface InTaskOpenId4VpAuthorizationRequest { client_id: string; request_uri: string }

/**
 * Demo additions. The v1 spec defines nothing after the request; these fields let the client show
 * what is asked, how far the exchange has got, and what was verified. Same key, clearly labelled.
 */
export interface InTaskOpenId4VpRequested { purpose: string; credentialType: string; claims: string[] }
export interface InTaskOpenId4VpAuthorizationStatus {
  sessionId: string
  state: 'RequestCreated' | 'RequestUriRetrieved' | 'ResponseVerified' | string
  expiresAt: string                        // agent start + AGENT_AUTH_TIMEOUT_MS
  requested: InTaskOpenId4VpRequested
}
export interface InTaskOpenId4VpAuthorizationResult {
  sessionId: string
  outcome: 'authorized' | 'denied'
  reason?: string                          // denial message (see T1 table)
  claims?: Record<string, unknown>
  issuer?: string
  holder?: string
  credentialType?: string
  status?: StatusCheck                     // from src/shared/presented-credential
  vpToken?: string
  verifiedAt?: string
}
export interface InTaskOpenId4VpMessageMetadata {
  authorizationRequest?: InTaskOpenId4VpAuthorizationRequest   // auth-required (spec)
  authorizationStatus?: InTaskOpenId4VpAuthorizationStatus     // auth-required, working (demo)
  authorizationResult?: InTaskOpenId4VpAuthorizationResult     // completed, failed (demo)
}
```

The AS mirrors it without the extension key: `GET /authorize` adds `session: { id, state }` and
`requested`; `GET /authorize/:id` answers `{ status: 'pending', session: { id, state } }`,
`{ status: 'granted', code, redirectTo, presentation: InTaskOpenId4VpAuthorizationResult }`, or
`403 { error: 'access_denied', error_description, presentation?: { …, outcome: 'denied', reason } }`.

`README.md` and `docs/ARCHITECTURE.md` get a paragraph "What the client learns about the
presentation (demo addition)".

### Phase 2 — the agent emits (`src/agent/index.ts`)

- `requested` is derived from `OFFICER_PRESENTATION_DEFINITION`: `purpose` = the definition's
  `purpose`, `credentialType` = the `$.vct` enum value, `claims` = the other field paths without
  `$.` (`['role', 'org']`).
- `sessionStates: Map<sessionId, string>`; `onNotification` and the 3 s poll write to it (only for
  sessions in `sessionToContext`); `waitForVerifiedPresentation(sessionId, onState)` calls
  `onState(state)` on every change.
- `auth-required` carries `authorizationRequest` **and** `authorizationStatus` (`RequestCreated`,
  `expiresAt`). Each state change emits `say('working', text, { metadata })` with the updated
  `authorizationStatus`: `RequestUriRetrieved` → "The wallet fetched the request.",
  `ResponseVerified` → "Presentation verified; checking the credential's status."
- `completed` carries `authorizationResult` built from T1's `{ presented, status }`
  (`outcome: 'authorized'`); `failed` for an `AuthorizationDenied` carries
  `{ outcome: 'denied', reason, sessionId, issuer?, status? }`. The text parts are unchanged.

### Phase 3 — the AS emits (`src/mcp/auth-server.ts`)

- `beginAuthorization` returns `session: { id, state: 'RequestCreated' }` and `requested`.
- Split `completeAuthorization` into `pollAuthorization(requestId)` →
  `{ state: 'pending', session } | { state: 'granted', code, redirectTo, presentation } | { state: 'denied', reason, presentation? }`,
  built from T1-B4's `IssuedCode.presented/status`. The route maps these to the three responses
  above; denial still deletes the pending entry.

### Phase 4 — the Trust Lens model (`src/web/presentation.ts`, `tasks.ts`, `mcp-client.ts`, `server.ts`)

```ts
// src/web/presentation.ts — shared by both paths
export type PresentationSource = 'wallet' | 'qr' | 'simulated' | 'unknown'
export interface AuthorizationView {
  request: string                          // openid4vp:// URI — the QR payload
  clientId?: string
  sessionId?: string
  state: 'requested' | 'wallet-fetched' | 'verified' | 'authorized' | 'denied' | 'expired'
  expiresAt?: string
  requested?: InTaskOpenId4VpRequested
  delivery?: DeliveryState
  source?: PresentationSource
}
export interface PresentationView extends InTaskOpenId4VpAuthorizationResult { source: PresentationSource }
export function toAuthorizationState(sessionState: string): AuthorizationView['state']
export function presentationFrom(result: InTaskOpenId4VpAuthorizationResult, source?: PresentationSource): PresentationView
```

- `TrackedTask` becomes `{ id, resource, state, startedAt, events, a2a?: { taskId, contextId }, preflight? (T1), authorization?: AuthorizationView, presentation?: PresentationView, result?, error? }`;
  `authorizationRequest`/`delivery` move under `authorization`. The `kind: 'task'` stream event
  fills `a2a`. `TaskTracker.list()` → newest first.
- `sendToWallet` sets `authorization.source = 'wallet'`; `simulatePresentation` sets `'simulated'`;
  a task that reaches `verified` with no source gets `'qr'`.
- Audit: `completed` records `authorization` with evidence `{ presentation }` (including
  `vpToken`); `failed` records `denial` with `{ presentation }` when present.
- `McpClient`: `PendingAuthorization` gains `session`, `requested`, `source`;
  `completeAuthorization` returns `{ granted: boolean; session?: { id, state }; presentation?: PresentationView }`
  and throws `AuthorizationDeniedError { presentation? }` on 403. Starting a step-up while one is
  pending **for the same scope and resource** returns the existing pending entry (closes
  ENHANCEMENTS §4).
- Routes: `GET /api/tasks` → `{ tasks: [{ id, resource, state, startedAt, a2a, presentation?: { outcome, claims } }] }`;
  `POST /api/mcp/call` adds `session`, `requested` to `authorization`;
  `POST /api/mcp/simulate-presentation` sets the source **and records**
  `presentation submitted (simulated holder)` exactly as the A2A route does (invariant 7);
  `POST /api/mcp/send-to-wallet` sets `'wallet'`; `GET /api/mcp/authorization` →
  `{ granted, token, delivery, session, presentation }`, and on denial `403 { error, presentation }`
  with a `denial` audit entry carrying `{ presentation }`; the token-issued entry gains
  `{ presentation }`.

### Phase 5 — the UI (`src/web/public/index.html`, `app.js`, `app.css`)

- **Nav:** Discovery · **Tasks** · MCP tools · Audit. `#tasks` lists `GET /api/tasks` as `.cards`
  (resource, state badge, `startedAt`, `Authorized by <role> · <org>` when present); a card opens
  the existing `#task` view via `watchTask(id)`. The Back button returns to Tasks.
- **Polling that survives navigation:** a `pollers` map keyed `task:<id>` / `mcp-auth`;
  `watchTask` keeps ticking until the task is final regardless of the visible view; the MCP poll
  resumes when the MCP view is shown and `pending` exists; a 409 from `/api/mcp/authorization`
  stops the poll and hides the panel.
- **Auth panel, both paths:** a "What is asked" block — `requested.purpose`, `credentialType`,
  claim chips (`role`, `org`), verifier `client_id` shortened; a step strip `<ol class="steps">`
  Requested → Wallet fetched → Verified → Status checked → Authorized, driven by
  `authorization.state`; a countdown `expires in mm:ss` from `expiresAt` (A2A; red under 30 s,
  then `expired`); the three ways to present as today; the simulate note stays visible until the
  step completes.
- **Presentation card** `<article class="card presentation">` rendered from `PresentationView`
  under the task events and above the MCP result: `Claims role · org`, `Credential <vct>`,
  `Issuer <did…> (TrustCo, trusted)`, `Holder <did:key…>`, `Status live · index n · checked hh:mm:ss`
  (or `revoked`, red), `Session <id8>`, `Verified hh:mm:ss`, `Presented via Heka Wallet (DIDComm) | QR scan | Simulated holder (demo)`
  — the last as `.badge.warn`. A denied presentation renders the same card with `.refused`, the
  reason, and no claims. **Raw VP** opens the drawer with the compact SD-JWT and each `~` segment
  decoded client-side (base64url → JSON) as `[salt, name, value]`.
- **Token badge** counts down every second from `expiresAt`; `Drop token` (T1) sits beside it.
- **Audit tab** renders evidence generically (`.kv` for scalars) and `presentation` as the
  compact card with the Raw VP link.
- **Results:** a `failed` task uses `.result.bad` (red border), not the green box.

### Phase 6 — docs

README Flow 2 (steps 5–7 and the diagram gain "status-update working: wallet fetched" and
"completed + authorizationResult (demo addition)"), Flow 3 (poll answers carry session and
presentation), `docs/ARCHITECTURE.md` (Authorization paths), `docs/GOAL.md` non-repudiation row
("the presentation is retained with the decision; still unsigned and in memory"),
`.claude/skills/demo-walkthrough/SKILL.md` §4–5 expected JSON (`authorization`, `presentation`),
`ENHANCEMENTS.md` §1 (VP retained; signing and persistence remain) and §4 removed.

## Definition of Done

- [ ] `extension.ts` exports the three metadata fields with the spec/demo labelling; the agent
      emits `authorizationStatus` on `auth-required` and on every session state change, and
      `authorizationResult` on `completed`/`failed`.
- [ ] The AS answers `session` on pending and `presentation` on granted/denied.
- [ ] `GET /api/task/:id` exposes `a2a`, `authorization` (with `state`, `expiresAt`, `requested`,
      `source`) and `presentation` (with `vpToken`); `GET /api/tasks` exists.
- [ ] `GET /api/mcp/authorization` exposes `session` and `presentation`; a second Invoke while
      pending reuses the same `requestId`.
- [ ] Both simulate routes record `presentation submitted (simulated holder)`; every completion
      and denial entry carries `evidence.presentation`.
- [ ] The UI has a Tasks tab; leaving and returning to a pending task or a pending MCP step-up
      keeps it live; 409 closes the panel.
- [ ] The presentation card appears on both paths, with the source badge, and Raw VP opens.
- [ ] The A2A countdown and the token TTL countdown move every second.
- [ ] Global DoD (README); ENHANCEMENTS §4 removed.

## Steps to validate

Stack per `run-demo` on this branch (it already contains T1 and T2). Curls from `demo/trust-lens`.

1. **Contract on the wire (A2A)** — engage the genuine agent and read the task:

   ```bash
   curl -s -X POST http://localhost:4000/api/engage -H "content-type: application/json" -d '{"identifier":"urn:air:acme-invoices.example:finance:invoice-agent"}'
   ```

   ```bash
   curl -s http://localhost:4000/api/task/<id> | jq '{state, a2a, authorization: .authorization | {state, expiresAt, requested, sessionId}}'
   ```

   Expect `state: "auth-required"`, `a2a.taskId` and `a2a.contextId` set, `authorization.state:
   "requested"`, `requested.claims: ["role","org"]`, `requested.credentialType:
   "urn:heka:role-credential:v1"`, an `expiresAt` about 180 s ahead.

2. **Simulated, labelled, retained**

   ```bash
   curl -s -X POST http://localhost:4000/api/task/<id>/simulate-presentation
   ```

   Within ~5 s `curl -s http://localhost:4000/api/task/<id> | jq '.presentation'` shows
   `outcome: "authorized"`, `claims.role: "Finance Data Officer"`, `issuer` = the seed issuer
   DID, `holder` starting with `did:key:`, `status.revoked: false`, `status.statusListIndex: 3`,
   `source: "simulated"`, `vpToken` starting with `ey`. The events include
   `Presentation verified; checking the credential's status.`
   `curl -s http://localhost:4000/api/audit | jq '.events[0:4]'` shows
   `task completed after verified presentation` with `evidence.presentation.source ==
   "simulated"` and `presentation submitted (simulated holder)`.

3. **UI, A2A** — Tasks tab lists the task with `Authorized by Finance Data Officer · TrustCo …`;
   open it: the timeline, then the presentation card with all rows and the amber
   `Simulated holder (demo)` badge; **Raw VP** opens the drawer with the compact token and
   decoded disclosures for `role` and `org`. Engage again, switch to Discovery and back to Tasks
   during `auth-required`: the countdown is still running.

4. **Live steps with the real wallet** — link the wallet; engage; press **Send to wallet**; open
   the request on the phone but do **not** tap Share yet: within ~5 s the step strip shows
   _Wallet fetched_ (agent log `session … -> RequestUriRetrieved`). The person taps **Share**:
   _Verified_ → _Status checked_ → _Authorized_; the card says `Presented via Heka Wallet (DIDComm)`.

5. **Denied is a card too** — revoke the officer credential in the console, engage, simulate:
   the task fails, the card renders red with `the Finance Data Officer credential has been
   revoked by its issuer`, `status.revoked: true`; the Audit tab shows the `denial` with the
   presentation evidence. Restore.

6. **MCP mirrors it** — Invoke `suppliers-export-bank-details`:
   `curl -s http://localhost:4000/api/mcp/authorization | jq '{granted, session}'` →
   `session.state: "RequestCreated"`. Invoke the same tool again while pending → the panel keeps
   the same QR and `yarn as` logs a single `awaiting a presentation` line. Simulate → the poll
   returns `granted: true` with `presentation.source: "simulated"`; the card appears above the
   bank details; the token badge counts down; the audit's `scoped token issued …` entry carries
   `evidence.presentation`. Leave to Audit and return to MCP tools during a pending step-up: the
   poll resumes and the panel is still there.

7. **409 handling** — with nothing pending, open the MCP tab: no panel, no repeated requests in
   the browser network log to `/api/mcp/authorization`.

8. `yarn typecheck && yarn test && yarn verify:live` → green, `RESULT: PASS`.

## Docs to update

`README.md` (Flow 2, Flow 3, "Open the demo" mentions the Tasks tab), `docs/ARCHITECTURE.md`,
`docs/GOAL.md`, `.claude/skills/demo-walkthrough/SKILL.md`, `ENHANCEMENTS.md` (§1 edited, §4 removed).

## Risks and open questions

- `expiresAt` is the agent's own timeout, not Heka's session lifetime (not exposed, ENHANCEMENTS
  §6). The countdown must say "agent timeout"; a session can expire earlier on a slow tap.
- Retaining `vpToken` in the in-memory audit grows memory by ~2 KB per presentation. Fine for a
  demo; note it in `docs/GOAL.md`.
- The `holder` for a phone-issued credential is whatever `cnf` Heka Wallet binds (`did:key` or a
  JWK thumbprint); the card should show either without assuming the format.
