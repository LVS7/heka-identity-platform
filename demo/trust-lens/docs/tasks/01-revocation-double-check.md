# T1 — Double-check the revocation mechanism for attestations

> Status: done · Branch: `task/01-revocation` from `litvinov-demo` · Depends on: the
> housekeeping commit (see [README](README.md)) · Next in the chain: `task/02-console-styling`
> branches from this one once this DoD is met (tasks run strictly in order 1 → 2 → 3 → 4 → 5)

## Why

The task of double-checking the revocation mechanism serves the following goals:

- the relying party checks revocation itself, of the credential that was actually presented
  (invariant 4)
- a missing, unreadable or malformed status input refuses instead of passing (invariant 5,
  fail closed)
- the kill switch is demonstrable without a container restart
- every audit finding is recorded with its status

The audit is done (findings below); what remains is to fix what violates the demo's own
invariants and to make the kill switch demonstrable without a container restart. Invariant 4 says
_the relying party checks revocation itself_, invariant 5 says _fail closed_. Today both hold on
the happy path and fail at the edges.

## Findings

The mechanism: a W3C Bitstring Status List published by Heka at `GET /credentials/status/{id}`
(unsigned JSON, read from the database on every request); a `credentialStatus`
`{statusListCredential, statusListIndex}` claim placed in every credential as a non-selectively-
disclosable claim (`src/seed.ts:133-139`, `src/shared/officer-offer.ts:37-40`);
`checkCredentialStatus` in `src/core/status-list.ts:65-76` fetching the list and reading the bit,
with no cache anywhere. The agent and the AS check after `ResponseVerified`
(`src/agent/index.ts:315-333`, `src/mcp/auth-server.ts:187-200`); the verification engine checks
last (`src/core/verify.ts`, step 6).

| #   | Finding                                                                                                                                   | Evidence                                                                     | Group    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------- |
| G1  | `/api/engage` trusts the `verdict` in the request body; a revoked passport can still be engaged until the operator re-verifies            | `src/web/server.ts:200-216`, `src/web/public/app.js` (cached verdict map)    | B        |
| G2  | Revoking the MCP passport (`acmeMcp`) changes only the badge; `/api/mcp/call` has no verdict gate                                         | `src/web/server.ts:277-316`                                                  | B        |
| G3  | An issued MCP token outlives a revocation for up to 300 s; `forgetToken()` is never called; the docs prescribe `docker restart`           | `src/web/mcp-client.ts:66-69`, README kill-switch step, `ENHANCEMENTS.md` §3 | B        |
| G4  | AS: `/token` does not re-check status; codes never expire                                                                                 | `src/mcp/auth-server.ts:81, 203-247`                                         | C        |
| G5  | Agent caches authorization per `contextId` forever; a client reusing a context never presents again                                       | `src/agent/index.ts:120, 216, 277`                                           | C        |
| G6  | Agent and AS check the **seed-state officer slot** (index 3), not the presented credential's own `credentialStatus`; neither checks `iss` | `src/agent/index.ts:316-327`, `src/mcp/auth-server.ts:188-196`               | A        |
| G6b | Heka does not constrain the issuer of a presentation; an officer credential from any issuer is accepted                                   | no trusted-issuer setting anywhere in `heka-identity-service/src`            | A        |
| G7  | Missing seed state → the check is **skipped** (fail-open)                                                                                 | `src/agent/index.ts:320-323`, `src/mcp/auth-server.ts:189`                   | A        |
| G8  | A credential without `credentialStatus` verifies as `VERIFIED` and can never be revoked                                                   | `src/core/verify.ts` step 6; `verify.test.ts` baseline fixture has no status | A        |
| G9  | A malformed `statusListIndex` (`NaN`, `undefined`) reads as "not revoked"                                                                 | `src/core/status-list.ts:43-53` (no validation of the claim)                 | A        |
| G10 | The status list is unsigned and its `issuer` is never compared with the credential's                                                      | `src/core/status-list.ts:56-59`                                              | C        |
| G11 | Officer revocation is a role slot shared by every issued officer credential, and Restore un-revokes a `purpose: revocation` list          | `src/shared/officer-offer.ts:23`, `src/shared/identity-service.ts:116`       | accepted |
| G12 | Console loads seed state once; after `yarn seed --reset` without a restart it revokes on the old list                                     | `src/console/server.ts:85`                                                   | C        |
| G13 | Console is unauthenticated (demo) and records nothing; the `revocation` audit type exists and is never written                            | `src/core/types.ts:120`, `src/console/server.ts:154-171`                     | B        |
| G14 | No timeout on the status-list fetch; a hanging endpoint stalls instead of refusing                                                        | `src/core/status-list.ts:69`                                                 | A        |
| G15 | Error labels: an unreadable list shows as `Agent error: …` on A2A, not as a denial; on the AS the pending entry survives a 403            | `src/agent/index.ts:237-243`, `src/mcp/auth-server.ts:166,176`               | A        |
| G16 | Check-then-use: the agent checks once and then runs the report without looking again                                                      | `src/agent/index.ts:226-236`                                                 | accepted |

What is **sound** and stays: the format, the no-cache policy, `verify.ts` failing closed on an
unreadable list, the console reading status live, `yarn derisk` proving the Heka round trip, and
the fixtures captured from a live service.

## Scope

- **Group A — invariant violations (must):** G6, G6b, G7, G8, G9, G14, G15.
- **Group B — demo-visible (must):** G1 and G2 (server-side gate for both resource types), G3
  (`DELETE /api/mcp/token` + button), G13 (revocation journal in the console).
- **Group C — hardening (optional phase, pending a separate decision):** G4, G5, G10, G12.
- **Audit report:** `docs/REVOCATION-AUDIT.md` recording every finding with its status.

### Non-goals

- Signing audit records or persisting them (ENHANCEMENTS §1 stays open; T3 retains the VP).
- Changing the seed, the status-list purpose, or the shared officer slot (G11 is documented as a
  known deviation, not fixed).
- Authentication on the console.

## Decisions (design review)

1. Agent and AS check the **presented credential**: `iss` must be the trusted issuer, `vct` must
   be the role credential, `credentialStatus` must be present and point at the issuer's service,
   and the bit must be clear, and the disclosed `role` must equal the officer role. No fallback
   to the seed slot. Missing anything → refuse.
2. A passport without `credentialStatus` gets a new verdict, `NO_STATUS` ("cannot be revoked, so
   cannot be trusted"), with its own row in the verdict table. Folding it into `REVOKED` was
   considered and rejected because it would hide the cause.
3. `/api/engage` re-verifies the one identifier server-side, ignores the client's verdict, and
   records the fresh verification. One to three seconds of Hedera resolution is acceptable.
4. Restore stays. `docs/REVOCATION-AUDIT.md` notes that W3C treats `revocation` as irreversible and
   that the demo uses the switch as suspension.
5. The console gets its own in-memory `AuditLog` and `GET /api/audit`; the Trust Lens audit is not
   involved (it already sees `REVOKED` verdicts).
6. Group C is planned as a separate phase and left unchecked pending a separate decision.

## Plan

### Phase A — fail-closed foundations (`src/core`)

**A1. Validate and bound the status check.** `src/core/status-list.ts`

- `readStatusBit(bitstring, index)`: throw unless `Number.isInteger(index) && index >= 0`.
- `checkCredentialStatus(status, fetchFn = fetch, options?: { timeoutMs?: number })`: validate the
  claim shape before fetching (`statusListCredential` is an `http(s)` URL string,
  `statusListIndex` a non-negative integer); fetch with
  `AbortSignal.timeout(options?.timeoutMs ?? 10_000)`; a timeout or network error rejects with
  `status list unavailable: <cause>`.
- Tests in `src/core/__tests__/status-list.test.ts`: `NaN` index throws; a non-integer throws;
  a missing URL throws; a `fetchFn` that never resolves rejects within `timeoutMs: 50`.

**A2. A missing status pointer is a verdict.** `src/core/types.ts`, `src/core/verify.ts`

- Add `Verdict.NoStatus = 'NO_STATUS'` and the evidence field `statusPointerPresent?: boolean`.
- Step 6 of `verifyEntry`: no `credentialStatus` →
  `decided(Verdict.NoStatus, evidence, 'passport carries no status pointer and can never be revoked')`.
- Tests in `src/core/__tests__/verify.test.ts`: the default `passportClaims()` fixture gains a
  `credentialStatus` (so the baseline stays `VERIFIED`); a new case removes it and expects
  `NO_STATUS` with `statusPointerPresent: false`.
- Docs: verdict list in `docs/ARCHITECTURE.md` (nine), README Flow 1 step 6, `ENHANCEMENTS.md`
  "Stage the five verdicts" (now six).

**A3. A dependency-free SD-JWT decoder.** New `src/core/sd-jwt.ts` (+ tests)

Display and policy need `iss`, `cnf`, `vct`, the disclosed claims and `credentialStatus` from the
`vp_token`. Heka has already verified the signature; the decoder does no crypto beyond hashing
disclosures to match `_sd` digests (`node:crypto`, allowed in core like `node:zlib`).

```ts
export interface SdJwtDisclosure {
  salt: string
  name?: string
  value: unknown
}
export interface DecodedSdJwtPresentation {
  issuerJwt: { header: Record<string, unknown>; payload: Record<string, unknown> }
  disclosures: SdJwtDisclosure[]
  /** issuer payload with `_sd` digests replaced by disclosed values; `_sd` and `_sd_alg` removed */
  claims: Record<string, unknown>
  keyBinding?: { header: Record<string, unknown>; payload: Record<string, unknown> }
}
export function decodeSdJwtPresentation(compact: string): DecodedSdJwtPresentation
/** `cnf.kid` if present, else the RFC 7638 SHA-256 thumbprint of `cnf.jwk`; undefined without `cnf`. */
export function holderBindingOf(decoded: DecodedSdJwtPresentation): string | undefined
```

- Compact form is `<issuer-jwt>~<disclosure>~…~<kb-jwt?>`; base64url via `Buffer`; `_sd_alg`
  defaults to `sha-256`; flat and nested-object `_sd` are supported; array disclosures (`...`)
  throw `unsupported: array disclosures` — no demo credential uses them.
- Fixture: capture a real `vp_token` once (simulate a presentation, then
  `GET $IDENTITY_SERVICE_URL/openid4vc/verification-session/<id>` with the bearer token) into
  `src/core/__tests__/fixtures/officer-presentation.sd-jwt`. Tests: `claims.role`, `claims.org`,
  `claims.credentialStatus.statusListIndex === 3`, `issuerJwt.payload.iss` equals the seed issuer,
  `holderBindingOf` returns a `did:key`, an input without `~` throws.

### Phase B — the presented credential is what gets checked (`src/shared`)

**B1. Read the whole session.** `src/shared/identity-service.ts:109-112`

```ts
export interface VerificationSessionRecord {
  id: string
  state: string
  sharedAttributes?: Record<string, unknown>
  authorizationResponsePayload?: { vp_token?: string | string[]; presentation_submission?: unknown }
}
public async getVerificationSession(id: string): Promise<VerificationSessionRecord>
```

**B2. One module, two relying parties.** New `src/shared/presented-credential.ts` (+ tests in
`src/shared/__tests__/presented-credential.test.ts`, injected `fetchFn`, no network)

```ts
export interface PresentedCredential {
  sessionId: string
  vct: string
  issuer: string
  holder?: string
  claims: Record<string, unknown>          // disclosed + non-SD claims (role, org, credentialStatus, …)
  credentialStatus?: CredentialStatusClaim
  vpToken: string
  verifiedAt: string
}
export interface PresentationPolicy {
  trustedIssuers: string[]
  requiredVct: string                      // ROLE_CREDENTIAL_VCT
  statusListOrigin: string                 // origin of IDENTITY_SERVICE_URL — the issuer's list lives there
  requiredClaims: Record<string, string>   // { role: OFFICER_CREDENTIAL.role } — disclosed with exactly this value
}
export interface StatusCheck { statusListCredential: string; statusListIndex: number; revoked: boolean; checkedAt: string }
export type RefusalReason =
  | 'not-verified' | 'malformed' | 'wrong-type' | 'untrusted-issuer' | 'wrong-role' | 'no-status' | 'foreign-status-list' | 'status-unavailable' | 'revoked'
export class PresentationRefused extends Error {
  constructor(public readonly reason: RefusalReason, message: string)
}

/** Pure: decode the session's vp_token. Throws 'not-verified' unless the state is ResponseVerified; 'malformed' if it then has no single vp_token. */
export function readPresentedCredential(session: VerificationSessionRecord): PresentedCredential
/** Policy + live status. Resolves with the StatusCheck; rejects with PresentationRefused otherwise. Never answers "unknown". */
export async function assertPresentedCredentialValid(
  presented: PresentedCredential,
  policy: PresentationPolicy,
  fetchFn?: typeof fetch
): Promise<StatusCheck>
```

Messages, because the docs and the UI key on them:

| Reason                | Message                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `revoked`             | `the Finance Data Officer credential has been revoked by its issuer` (unchanged)                          |
| `status-unavailable`  | `status list unavailable, refusing to assume valid: <cause>`                                              |
| `untrusted-issuer`    | `credential issued by <iss>, which this relying party does not trust`                                     |
| `wrong-role`          | `credential claim "<name>" is "<value>", expected "<expected>"`                                           |
| `no-status`           | `credential carries no status pointer and cannot be revoked`                                              |
| `foreign-status-list` | `credential points at a status list outside the issuer's service`                                         |
| `wrong-type`          | `credential is not a <requiredVct>`                                                                       |
| `not-verified`        | `no verified presentation yet (session is <state>)` (unchanged, used for polling)                         |
| `malformed`           | `presentation could not be decoded: <cause>` (Heka accepted it, so it should not happen; still a refusal) |

Tests: one case per `RefusalReason`, one happy path returning `StatusCheck`, `vp_token` given as
an array is accepted, `sharedAttributes` is ignored (the decoded token is authoritative).

**B3. Agent.** `src/agent/index.ts`

- `awaitAuthorization(sessionId, contextId)` becomes
  `Promise<{ presented: PresentedCredential; status: StatusCheck }>`: wait for `ResponseVerified`,
  `getVerificationSession`, `readPresentedCredential`, `assertPresentedCredentialValid` with
  `trustedIssuers: [loadState().issuerDid]` (missing → `AuthorizationDenied('no trusted issuer configured — run yarn seed')`),
  `requiredVct: ROLE_CREDENTIAL_VCT`, `statusListOrigin: new URL(IDENTITY_SERVICE_URL).origin`.
- Every `PresentationRefused` becomes `AuthorizationDenied` with the same message, so the task
  fails as `Authorization denied: …` (fixes G15). Delete `assertCredentialNotRevoked` and the
  `checkCredentialStatus` import.
- Log: `[agent] status checked: index <n> on <list> -> live|revoked`.

**B4. Authorization server.** `src/mcp/auth-server.ts`

- `completeAuthorization`: the same sequence; the token's `role`/`org` come from
  `presented.claims` — the `OFFICER_CREDENTIAL` fallback at lines 168-172 is deleted (a missing
  claim is a refusal, not a default).
- On any `PresentationRefused` other than `not-verified`: delete the pending entry **before**
  throwing (the second half of G15); the route then answers 403 as today.
- `IssuedCode` keeps `presented` and `status` so T3 can return them.

### Phase C — demo-visible gates and journal

**C1. Drop the cached token.** `src/web/server.ts`, `src/web/public/{index.html,app.js}`

- `DELETE /api/mcp/token` → `mcp.forgetToken()`; audit `authorization`, subject `MCP · token`,
  outcome `cached access token dropped by the operator`, evidence `{ hadToken, expiresInSeconds }`;
  response `{ token: mcp.tokenStatus }`.
- MCP tab: a `Drop token` button next to `#token-status`, enabled only while a token is present.
- Docs: README kill-switch step and `.claude/skills/demo-walkthrough/SKILL.md` §6 replace
  `docker restart trustlens-web` with the button / `curl -X DELETE`; `ENHANCEMENTS.md` §3 is removed.

**C2. The engage gate re-verifies.** `src/web/server.ts:200-220`, `src/web/tasks.ts`, `app.js`

- `POST /api/engage { identifier }`: discover, find the entry, run `verifyEntry` for it with the
  same options as `/api/verify`, record `verification`; not `VERIFIED` → record
  `engagement_refused` with `{ reason: 'resource is not VERIFIED at engagement time', verdict }`
  and answer `403 { error: 'refused: not verified', verdict, auditId }`. A `verdict` in the body
  is accepted for compatibility and never read.
- For an MCP-type entry the same check runs and the answer is
  `{ ok: true, kind: 'mcp', verdict, verifiedAt }` (T5 builds the connection on top of this).
- `TaskTracker.start(resource, prompt, preflight: { verdict, auditId, verifiedAt })` stores it on
  `TrackedTask.preflight`; the task view's context line reads
  `Re-verified <hh:mm:ss> · VERIFIED — asking it to …`.
- `app.js` `engage()` sends only `identifier`; on 403 it shows the verdict from the response.

**C3. The issuer keeps a journal.** `src/console/server.ts`, `src/core/types.ts`

- `AuditEventType` gains `'issuance'`.
- The console creates `new AuditLog()`; `POST /api/credentials/:key/status` records `revocation`
  with subject = tile title, outcome `REVOKED` | `RESTORED`, evidence
  `{ key, statusListIndex, statusList }`; `POST /api/credentials/officer/offer` records `issuance`
  with outcome `offer minted`, evidence `{ delivered, via: 'DIDComm basic message' | 'offer URI' }`.
- `GET /api/audit?type=` → `{ events }` newest first (same shape as the Trust Lens).
- The hidden key `pro` stays accepted (it exists in seed state); the journal makes its use visible.

### Phase D — optional hardening (unchecked pending a separate decision)

- **D1** `src/mcp/auth-server.ts`: codes expire after 60 s (`issuedAt` on `IssuedCode`);
  `/token` re-runs `assertPresentedCredentialValid` on the stored `presented` before minting.
- **D2** `src/agent/index.ts`: `authorizedContexts` becomes `Map<contextId, expiresAt>` with TTL
  `AS_TOKEN_TTL` seconds, so both paths forget an authorization on the same clock. T4's
  "Forget authorizations" button clears it.
- **D3** `src/core/status-list.ts`: `isRevokedInStatusList` gains an optional `expectedIssuer`;
  a list whose `issuer` differs from the credential's `iss` counts as unavailable.
- **D4** `src/console/server.ts`: `loadState()` per request instead of once at boot.

### Phase E — the report

`docs/REVOCATION-AUDIT.md`: the mechanism in one paragraph; the findings table above with a
_Status_ column (`fixed in T1-A1` … / `accepted, see § Restore` / `deferred to phase D`); the
Restore-versus-suspension note (G11); the list of live checks that prove the kill switch
(`yarn derisk` and the validation steps below). Link it from `docs/ARCHITECTURE.md` "Where
decisions are written down".

## Definition of Done

- [ ] Phases A, B, C and E merged; phase D either merged or explicitly declined, with the
      decision recorded in `docs/REVOCATION-AUDIT.md`.
- [ ] `src/core/sd-jwt.ts` and `src/shared/presented-credential.ts` exist with the interfaces
      above and are the only place the agent and the AS evaluate a presentation.
- [ ] `grep -rn "statusIndexes.officer" src/agent src/mcp` returns nothing.
- [ ] `grep -rn "skipping the revocation check" src` returns nothing; missing seed state, missing
      `credentialStatus`, untrusted issuer, foreign list, unreadable list and malformed index all
      refuse, each with the message from the B2 table.
- [ ] `NO_STATUS` is in the verdict table, documented and tested.
- [ ] `DELETE /api/mcp/token` exists, the MCP tab has the button, and no doc or skill mentions
      `docker restart trustlens-web` for the kill switch.
- [ ] `POST /api/engage` refuses with the server's own verdict regardless of the body.
- [ ] The console writes `revocation` and `issuance` entries and serves `GET /api/audit`.
- [ ] `docs/REVOCATION-AUDIT.md` exists and every G-number has a status.
- [ ] Global DoD (README): typecheck, tests, `verify:live`, docs, ENHANCEMENTS §3 removed.

## Steps to validate

Stack per `run-demo` (Heka, `yarn sites`, `yarn agent`, `yarn as`, `yarn mcp`, `yarn web`,
`yarn console`), seed complete (`yarn seed --check`). All curls run from `demo/trust-lens`.

1. **Unit and type checks**

   ```bash
   yarn typecheck && yarn test
   ```

   Expect `sd-jwt.test.ts` and `presented-credential.test.ts` listed and green; `verify.test.ts`
   has a `NO_STATUS` case; `status-list.test.ts` has the malformed-index and timeout cases.

2. **The engage gate ignores the client** — the lookalike, with a forged verdict:

   ```bash
   curl -s -i -X POST http://localhost:4000/api/engage -H "content-type: application/json" -d '{"identifier":"urn:air:acme-invoices-ai.example:finance:invoice-agent","verdict":"VERIFIED"}'
   ```

   Expect `HTTP/1.1 403`, a body with `"verdict":"SUBJECT_MISMATCH"` and an `auditId`.
   `curl -s http://localhost:4000/api/audit | head -c 800` shows a fresh `verification` entry and
   an `engagement_refused` entry with `resource is not VERIFIED at engagement time`.

3. **A revoked passport cannot be engaged, without re-verifying in the UI**

   ```bash
   curl -s -X POST http://localhost:4100/api/credentials/acmeAgent/status -H "content-type: application/json" -d '{"revoked":true}'
   ```

   ```bash
   curl -s -i -X POST http://localhost:4000/api/engage -H "content-type: application/json" -d '{"identifier":"urn:air:acme-invoices.example:finance:invoice-agent"}'
   ```

   Expect 403 with `"verdict":"REVOKED"`. Restore:

   ```bash
   curl -s -X POST http://localhost:4100/api/credentials/acmeAgent/status -H "content-type: application/json" -d '{"revoked":false}'
   ```

   Console journal — `curl -s http://localhost:4100/api/audit` shows two `revocation` entries,
   outcomes `REVOKED` then `RESTORED`, subject `Resource Passport — Acme Invoice Agent`.

4. **An A2A denial names the presented credential's status** — revoke the officer credential in
   the console UI (`http://localhost:4100`, Revoke on _Finance Data Officer_). In the Trust Lens:
   Discovery → Verify all → Engage _Acme Invoice Agent_ → **Simulate presentation (demo)**.
   Expect the task to fail with
   `Authorization denied: the Finance Data Officer credential has been revoked by its issuer`, and
   the agent log line
   `[agent] status checked: index 3 on http://localhost:3000/credentials/status/<id> -> revoked`.
   Restore the credential, engage again, simulate: `completed`, agent log ends with `-> live`.

5. **The MCP kill switch without a restart** — MCP tools tab: Invoke
   `suppliers-export-bank-details`, simulate, wait for `token · …s left` and the bank details.
   Revoke the officer credential in the console. Invoke again: it still succeeds (that is OAuth;
   the doc says so). Press **Drop token**: the badge reads `no token`, the audit gains
   `cached access token dropped by the operator`. Invoke → 401 → simulate → the panel shows
   `the Finance Data Officer credential has been revoked by its issuer`;
   `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/api/mcp/authorization` prints
   `409` (the pending entry was cleared). Restore the credential.

   The curl equivalent of the button:

   ```bash
   curl -s -X DELETE http://localhost:4000/api/mcp/token
   ```

   Expect `{"token":{"present":false,"expiresInSeconds":0}}`.

6. **Real wallet pass (final)** — link the wallet (`wallet-flow`), repeat step 4 with **Send to
   wallet** instead of simulate; the person taps **Share**. Same denial text while revoked, same
   completion after restore.

7. **Nothing else moved**

   ```bash
   yarn verify:live && yarn derisk
   ```

   Expect `RESULT: PASS` and the derisk revoke/observe sequence unchanged.

8. **The report** — open `docs/REVOCATION-AUDIT.md`; every G-number has a status;
   `ENHANCEMENTS.md` no longer has §3 and its table is renumbered.

## Docs to update

`README.md` (Flow 1 step 6 verdict list; kill-switch step), `docs/ARCHITECTURE.md` (verdicts;
invariant 4 wording: "checks the presented credential's own status pointer"; decisions list),
`docs/OPERATIONS.md` (no restart for the kill switch), `.claude/skills/demo-walkthrough/SKILL.md`
§6, `ENHANCEMENTS.md` (§3 removed, verdict count in the former §5, now §4), new `docs/REVOCATION-AUDIT.md`.

## Risks and open questions

- The `vp_token` shape in `authorizationResponsePayload` (string versus array, `direct_post.jwt`
  unwrapping) is asserted from Credo's record type, not yet observed. Capturing the fixture in A3
  is the first step of the task precisely so this is settled before B2 is written.
- `NO_STATUS` cannot be produced on a running stand (every seeded passport has a pointer). It is
  unit-tested only; ENHANCEMENTS §4 (seed flags for broken variants) would make it visible.
- Re-verifying at engage adds Hedera resolution latency to every Engage click. If it is felt in
  a demo, cache DID documents in the verifier agent for the process lifetime (they are immutable
  for the demo's DIDs) — never status lists.
