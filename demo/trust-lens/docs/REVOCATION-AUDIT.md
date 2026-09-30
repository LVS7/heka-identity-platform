# Revocation audit (2026-09-25)

How revocation works in this demo, what the audit found, and what was done about it.

## The mechanism

Heka publishes a W3C Bitstring Status List at `GET /credentials/status/{id}`: unsigned JSON, read
from the database on every request, never cached. Every credential carries a `credentialStatus`
claim (`{statusListCredential, statusListIndex}`) as a non-selectively-disclosable claim, so it
travels with the credential itself rather than being looked up separately. Each relying party
reads the bit itself — the verification engine checks it last, as the closing step of
`verifyEntry`; the agent and the authorization server evaluate the presented `vp_token` (issuer,
credential type, the disclosed `role`, status pointer, live bit) through the shared `src/shared/presented-credential.ts`,
never through cached or seed-held state. That module also refuses with reason `malformed` when a
`vp_token` cannot be decoded — Heka has already verified the presentation cryptographically, so
this should not happen, but a failure to evaluate is a refusal, not an exception.

## Findings and status

The Evidence column cites line numbers as of commit `08ae63e`, before this branch changed those files.

| #   | Finding                                                                                                                                     | Evidence                                                                               | Status                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| G1  | `/api/engage` trusts the `verdict` in the request body; a revoked passport can still be engaged until the operator re-verifies              | `src/web/server.ts:200-216`, `src/web/public/app.js` (cached verdict map)              | fixed — Task 9 (`/api/engage` re-verifies)                                                                                                 |
| G2  | Revoking the MCP passport (`acmeMcp`) changes only the badge; `/api/mcp/call` has no verdict gate                                           | `src/web/server.ts:277-316`                                                            | partially fixed — Task 9 gates Engage for MCP entries; a per-call gate on /api/mcp/call is carried into T5 (docs/tasks/05-mcp-llm-chat.md) |
| G3  | An issued MCP token outlives a revocation for up to 300 s; `forgetToken()` is never called; the docs prescribe `docker restart`             | `src/web/mcp-client.ts:66-69`, README kill-switch step, `ENHANCEMENTS.md` §3           | fixed — Task 8 (`DELETE /api/mcp/token`)                                                                                                   |
| G4  | AS: `/token` does not re-check status; codes never expire                                                                                   | `src/mcp/auth-server.ts:81, 203-247`                                                   | deferred — phase D1 (lead's call)                                                                                                          |
| G5  | Agent caches authorization per `contextId` forever; a client reusing a context never presents again                                         | `src/agent/index.ts:120, 216, 277`                                                     | deferred — phase D2                                                                                                                        |
| G6  | Agent and AS check the **seed-state officer slot** (index 3), not the presented credential's own `credentialStatus`; neither checks `iss`   | `src/agent/index.ts:316-327`, `src/mcp/auth-server.ts:188-196`                         | fixed — Tasks 5–7                                                                                                                          |
| G6b | Heka does not constrain the issuer of a presentation; an officer credential from any issuer is accepted                                     | no trusted-issuer setting anywhere in `heka-identity-service/src`                      | fixed — Tasks 5–7 (issuer checked against the seed anchor)                                                                                 |
| G7  | Missing seed state → the check is **skipped** (fail-open)                                                                                   | `src/agent/index.ts:320-323`, `src/mcp/auth-server.ts:189`                             | fixed — Tasks 6–7 (missing seed state refuses)                                                                                             |
| G8  | A credential without `credentialStatus` verifies as `VERIFIED` and can never be revoked                                                     | `src/core/verify.ts` step 6; `verify.test.ts` baseline fixture has no status           | fixed — Task 3 (`NO_STATUS`)                                                                                                               |
| G9  | A malformed `statusListIndex` (`NaN`, `undefined`) reads as "not revoked"                                                                   | `src/core/status-list.ts:43-53` (no validation of the claim)                           | fixed — Task 2                                                                                                                             |
| G10 | The status list is unsigned and its `issuer` is never compared with the credential's                                                        | `src/core/status-list.ts:56-59`                                                        | deferred — phase D3                                                                                                                        |
| G11 | Officer revocation is a role slot shared by every issued officer credential, and Restore un-revokes a `purpose: revocation` list            | `src/shared/officer-offer.ts:23`, `src/shared/identity-service.ts:116`                 | accepted — see § Restore                                                                                                                   |
| G12 | Console loads seed state once; after `yarn seed --reset` without a restart it revokes on the old list                                       | `src/console/server.ts:85`                                                             | deferred — phase D4                                                                                                                        |
| G13 | Console is unauthenticated (demo) and records nothing; the `revocation` audit type exists and is never written                              | `src/core/types.ts:120`, `src/console/server.ts:154-171`                               | fixed — Task 10 (journal); authentication stays out of scope                                                                               |
| G14 | No timeout on the status-list fetch; a hanging endpoint stalls instead of refusing                                                          | `src/core/status-list.ts:69`                                                           | fixed — Task 2 (10 s timeout)                                                                                                              |
| G15 | Error labels: an unreadable list shows as `Agent error: …` on A2A, not as a denial; on the AS the pending entry survives a 403              | `src/agent/index.ts:237-243`, `src/mcp/auth-server.ts:166,176`                         | fixed — Tasks 6–7                                                                                                                          |
| G16 | Check-then-use: the agent checks once and then runs the report without looking again                                                        | `src/agent/index.ts:226-236`                                                           | accepted — an ordinary check-then-use window                                                                                               |
| G17 | The `role` value was never checked: any live role credential from TrustCo (`vct` matched, `role` only `type: string`) authorized the export | `src/agent/index.ts:56-75`, `src/mcp/auth-server.ts:59-77` (found in the final review) | fixed — `requiredClaims: { role }` in the policy (`wrong-role`), `enum` on `$.role` in both presentation definitions                       |

G16 applies to the resource passport too: it is verified at engage and not re-checked while the task
runs — the same check-then-use window; the officer credential is still checked at the sensitive step.

## Restore

The W3C Bitstring Status List specification treats purpose `revocation` as irreversible: once a
bit is set, the spec's model does not expect it to be cleared. This demo's console Restore button
un-sets the bit anyway, so in spec terms the mechanism the demo implements is suspension, not
revocation, even though the status list is declared with purpose `revocation` (G11). This is kept
deliberately — the stand needs to be re-run without re-seeding new DIDs and credentials between
demo sessions, and re-seeding costs several minutes of Hedera writes. If asked whether this is
spec-conformant: it is not, and that is a known, accepted deviation, not an oversight.

## Phase D — optional hardening (not done)

Four items from the double-check plan remain unchecked, left for the lead to accept or decline
rather than folded into this branch:

- **D1 — expiring authorization codes.** `src/mcp/auth-server.ts`: an issued code never expires and
  `/token` does not re-check status at redemption; codes should expire after 60 seconds and
  `/token` should re-run `assertPresentedCredentialValid` on the stored presentation before
  minting (closes G4).
- **D2 — expiring agent authorization cache.** `src/agent/index.ts`: `authorizedContexts` is cached
  forever per `contextId`; it should carry a TTL matching the authorization server's token
  lifetime so both paths forget an authorization on the same clock (closes G5).
- **D3 — status list issuer binding.** `src/core/status-list.ts`: the status list is unsigned and
  its own `issuer` field is never compared against the presented credential's `iss`; a list whose
  issuer differs from the credential's should count as unavailable (closes G10).
- **D4 — live seed state in the console.** `src/console/server.ts`: seed state is loaded once at
  boot; a `yarn seed --reset` without a service restart revokes against stale data. Loading it per
  request would close G12.

## How to prove the kill switch

`yarn derisk` exercises the issue → status-bound → revoke → observe round trip directly against
Heka and is the fastest standalone check. For the full demo-level proof, run validation steps 2–7
in `docs/tasks/01-revocation-double-check.md` § "Steps to validate": step 2 shows the engage gate
ignoring a forged verdict, step 3 shows a revoked passport refusing engagement and the console
journal recording it, step 4 shows an A2A task denied by name once the officer credential is
revoked, step 5 shows the MCP token kill switch working without a container restart, step 6
repeats step 4 with the real wallet, and step 7 confirms `yarn verify:live` and `yarn derisk` still
pass.
