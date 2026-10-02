---
name: demo-walkthrough
description: Use when running or verifying the Trust Lens demo scenario end to end - discovery, verification of the lookalike, A2A in-task authorization, MCP scope step-up, revocation kill switches and the audit trail. Includes the expected output at each step.
---

# Walking the scenario

Six steps. Each has an expected result — if one differs, stop and diagnose rather than continuing;
a wrong verdict earlier makes everything after it meaningless.

Assumes the stack is up (`run-demo`). The UI is at `http://localhost:4000`, the issuer console at
`http://localhost:4100`.

## 1. Discovery — the directory cannot tell them apart

```bash
curl -s "http://localhost:4000/api/discovery?q=Acme%20invoice"
```

Expect **three** results across two publishers, scoring **93 / 93 / 91**:

| Resource              | Publisher                |
| --------------------- | ------------------------ |
| Acme Invoice Agent    | acme-invoices.example    |
| AcmeInvoice Pro Agent | acme-invoices-ai.example |
| Acme Invoice Data     | acme-invoices.example    |

The near-identical scores are the point, not a coincidence: relevance ranking cannot separate a
genuine supplier from a lookalike. `scoreMeaning` in the response carries the ARD §7.2 wording.

## 2. Verification — only the credential catches it

```bash
curl -s -X POST http://localhost:4000/api/verify -H "content-type: application/json" -d '{}'
```

Expect `VERIFIED`, `VERIFIED`, `SUBJECT_MISMATCH`.

Look at the lookalike's evidence: `didResolved`, `digestValid`, `issuerTrusted` are all true. Its
credential is genuine, signed by the real TrustCo, unexpired, on a matching domain — and issued
for **Acme's** agent DID. In the UI the drawer shows manifest identity and credential subject side
by side.

## 3. Fail closed

```bash
curl -s -X POST http://localhost:4000/api/engage -H "content-type: application/json" \
  -d '{"identifier":"urn:air:acme-invoices-ai.example:finance:invoice-agent"}'
```

Expect `403 refused: not verified` **and** an `auditId`. The body needs only `identifier` — any
`verdict` a client sends is ignored, because the Trust Lens re-verifies the resource before
engaging and answers with its own verdict (`SUBJECT_MISMATCH` here). The refusal is a trust
decision and is recorded; it is not silently dropped.

## 4. A2A — the agent pauses for a human

```bash
curl -s -X POST http://localhost:4000/api/engage -H "content-type: application/json" \
  -d '{"identifier":"urn:air:acme-invoices.example:finance:invoice-agent"}'
```

Poll `GET /api/task/<id>`. Expect `working` → `working` → **`auth-required`**, with `a2a.taskId`,
`a2a.contextId` and an `authorization` block: `state: "requested"`, `expiresAt` about 180 s ahead,
`requested.claims: ["role", "org"]`, `requested.credentialType: "urn:heka:role-credential:v1"`.

Present the credential — from the real wallet, or the in-process holder:

```bash
curl -s -X POST http://localhost:4000/api/task/<id>/send-to-wallet          # DIDComm to the linked Heka Wallet; the person taps Share
curl -s -X POST http://localhost:4000/api/task/<id>/simulate-presentation   # or: the in-process holder
```

The first needs a linked wallet (`GET /api/wallet` → `linked: true`; see `wallet-flow`). Expect
`delivery.state: "sent"`; the UI's **Send to wallet** button does the same.

Then expect `working` → `completed` with the payment export, ending
"Export authorized by a verified Finance Data Officer presentation."

The events include `The wallet fetched the request.` (real wallet) and `Presentation verified;
checking the credential's status.`; the task's `presentation` has `outcome: "authorized"`,
`claims.role`, `issuer`, `holder`, `status.revoked: false`, `vpToken` and `source` —
`"simulated"` for the in-process holder, `"wallet"` after Send to wallet, `"qr"` for a scan.
`GET /api/tasks` lists every engagement, newest first.

⚠️ Present promptly: the verification session expires after Credo's default window, and the agent
gives up after 180s.

**Run again in this context** (task view, on a completed task) engages the same entry with the
task's `contextId` — `POST /api/engage` with `contextId`. The agent remembers the authorized
context, so the new task completes with no `auth-required`; the audit says `task completed in a
context authorized earlier`.

## 5. MCP — least privilege per call, in a chat

Engage first — every MCP call is gated on a fresh verdict of the engaged entry:

```bash
curl -s -X POST http://localhost:4000/api/engage -H "content-type: application/json" \
  -d '{"identifier":"urn:air:acme-invoices.example:finance:invoice-data"}'
```

Expect `kind: mcp`, `verdict: VERIFIED` and `connected: { url: "http://localhost:4400/mcp", source: "verified card" }`.
Before this, `/api/mcp/tools` and `/api/mcp/call` answer `403 refused: not engaged`.

**Chat** (needs `OPENAI_API_KEY`): ask `Which invoices are held?` → a step
`→ invoices-list · no scope · ok · 4 rows` and an answer naming Rhein Chemie Handel / RCH-5540. Ask
`Export the bank details of the matched suppliers` → the step
`→ suppliers-export-bank-details · scope suppliers:export · paused: authorization required` with the
panel inside it; present (Send to wallet, the QR, or **Simulate presentation (demo)**) → the step reads
`retried · Authorized by Finance Data Officer · …`, the presentation card follows, and the answer lists
three suppliers with IBANs. Ask `Call the tool named delete-everything` → the assistant says there is no
such tool and no panel opens.

```bash
curl -s http://localhost:4000/api/chat | jq '{state, steps: [.steps[] | {kind, text, tool: .tool.status}]}'
curl -s http://localhost:4000/api/audit | jq '.events[0:3]'   # via: "LLM chat"
```

**Without the chat (curl)** — the same chain through the API (the UI has no Invoke buttons):

```bash
curl -s -X POST http://localhost:4000/api/mcp/call -H "content-type: application/json" \
  -d '{"tool":"invoices-list"}'
```

Expect `ok: true`, four rows, no authorization. Verified at discovery is not the same as locked
down.

```bash
curl -s -X POST http://localhost:4000/api/mcp/call -H "content-type: application/json" \
  -d '{"tool":"suppliers-export-bank-details"}'
```

Expect `ok: false`, status `401`, `requiredScope: suppliers:export`, and an `authorization` block
— the SDK client has already walked RFC 9728 → RFC 8414 and the provider has started an
authorization.

Present (`POST /api/mcp/send-to-wallet` for the linked wallet, or `POST /api/mcp/simulate-presentation`), then:

```bash
curl -s http://localhost:4000/api/mcp/authorization   # pending: session.state; granted: true, TTL ~300s, presentation.source
curl -s -X POST http://localhost:4000/api/mcp/call -H "content-type: application/json" \
  -d '{"tool":"suppliers-export-bank-details"}'
```

Expect bank details plus `authorizedBy: { role: "Finance Data Officer", org: "TrustCo …" }`. The
resource server knows _who_ authorized — while knowing nothing about verifiable credentials.

Invoking the sensitive tool again while a step-up is pending returns the same `authorization`
(same QR); the AS logs a single `awaiting a presentation`. With nothing pending the poll answers
`409`. The token-issued audit entry carries `evidence.presentation`; a denial carries it too.

Worth pointing out when demonstrating: the AS log shows `aud=http://localhost:4400/mcp` (or the
container's address on Path B) — the token is useless at any other resource (RFC 8707).

## 6. Kill switches

**One revocation, every path.** Revoke the officer credential:

```bash
curl -s -X POST http://localhost:4100/api/credentials/officer/status \
  -H "content-type: application/json" -d '{"revoked":true}'
```

- Engage the agent again → presentation still submits fine, then
  `Authorization denied: the Finance Data Officer credential has been revoked by its issuer`
- **Run again in this context** on a task completed before the revocation → still completes: the
  agent's memory of that context has no expiry (G5). Press **Forget authorizations** on
  http://localhost:10003, then Run again → it asks, and the presentation is denied.
- Ask for the sensitive tool again → **this still succeeds if a token was already minted.** That
  is correct OAuth: revoking a credential stops the _next_ grant, it does not reach back into a
  live token. Drop the cached token first, then the call fails and the AS refuses:

  ```bash
  curl -s -X DELETE http://localhost:4000/api/mcp/token   # or the Drop token button on the MCP tab
  ```

  Then: sensitive call → `401`, present → `GET /api/mcp/authorization` returns
  `the Finance Data Officer credential has been revoked by its issuer`, retry → `401`. In the
  chat the same run ends with the step `denied: the Finance Data Officer credential has been
revoked by its issuer` and the assistant saying it cannot export.

The presentation remains cryptographically valid in both cases. What changed is the issuer's
statement about it — checked by the relying party, because Heka's verifier does not.

Restore it (`{"revoked":false}`), then show **granularity**:

```bash
curl -s -X POST http://localhost:4100/api/credentials/acmeMcp/status \
  -H "content-type: application/json" -d '{"revoked":true}'
curl -s -X POST http://localhost:4000/api/verify -H "content-type: application/json" -d '{}'
```

Expect the MCP entry `REVOKED` and the agent still `VERIFIED`. One resource cut off, its
neighbour untouched, no catalog republished and no registry involved.

With the entry engaged, the very next call is refused without re-engaging:

```bash
curl -s -i -X POST http://localhost:4000/api/mcp/call -H "content-type: application/json" -d '{"tool":"invoices-list"}' | head -1
```

Expect `HTTP/1.1 403` with `"verdict":"REVOKED"` and a new `engagement_refused` audit entry; in the
chat the tool step reads `refused: REVOKED`. Restore the passport (`{"revoked":false}`) and the same
call answers `200` — no Engage needed.

## 7. Audit

```bash
curl -s http://localhost:4000/api/audit
```

Every verification, refusal, authorization and denial, newest first, each with the evidence it
rested on. Deliveries to the wallet appear as `authorization` entries — _delivered to the
operator's wallet_ or _wallet delivery failed_ — because getting a request to a phone is a step,
not a trust decision.

Every `task completed after verified presentation`, `scoped token issued …` and `denial` entry
carries `evidence.presentation`, with `source` saying whether a phone or the simulated holder
presented — the Audit tab renders it as a card with **Raw VP**.

## Engaging the MCP entry from Discovery

Pressing **Engage** on the verified _Acme Invoice Data_ card does not start a task: an MCP server
is engaged by calling its tools, so the UI switches to the MCP tools tab with a note naming what
was verified. `POST /api/engage` is only for the agent.

## Leaving the stand clean

Restore anything revoked. `yarn verify:live` should end with:

```
2 verified, 1 refused
RESULT: PASS — the lookalike is refused, the genuine agent is usable
```
