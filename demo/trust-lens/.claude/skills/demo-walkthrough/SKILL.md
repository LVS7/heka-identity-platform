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

| Resource | Publisher |
|---|---|
| Acme Invoice Agent | acme-invoices.example |
| AcmeInvoice Pro Agent | acme-invoices-ai.example |
| Acme Invoice Data | acme-invoices.example |

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
  -d '{"identifier":"urn:air:acme-invoices-ai.example:finance:invoice-agent","verdict":"SUBJECT_MISMATCH"}'
```

Expect `403 refused: not verified` **and** an `auditId`. The refusal is a trust decision and is
recorded; it is not silently dropped.

## 4. A2A — the agent pauses for a human

```bash
curl -s -X POST http://localhost:4000/api/engage -H "content-type: application/json" \
  -d '{"identifier":"urn:air:acme-invoices.example:finance:invoice-agent","verdict":"VERIFIED"}'
```

Poll `GET /api/task/<id>`. Expect `working` → `working` → **`auth-required`**, with
`authorizationRequest` set.

Present the credential — from a real wallet (see `wallet-flow`) or the in-process holder:

```bash
curl -s -X POST http://localhost:4000/api/task/<id>/simulate-presentation
```

Then expect `working` → `completed` with the payment export, ending
"Export authorized by a verified Finance Data Officer presentation."

⚠️ Present promptly: the verification session expires after Credo's default window, and the agent
gives up after 180s.

## 5. MCP — least privilege per call

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
— the client has already walked RFC 9728 → RFC 8414 and started an authorization.

Present (wallet or `POST /api/mcp/simulate-presentation`), then:

```bash
curl -s http://localhost:4000/api/mcp/authorization   # granted: true, TTL ~300s
curl -s -X POST http://localhost:4000/api/mcp/call -H "content-type: application/json" \
  -d '{"tool":"suppliers-export-bank-details"}'
```

Expect bank details plus `authorizedBy: { role: "Finance Data Officer", org: "TrustCo …" }`. The
resource server knows *who* authorized — while knowing nothing about verifiable credentials.

Worth pointing out when demonstrating: the AS log shows `aud=http://trustlens-mcp:4400` — the
token is useless at any other resource (RFC 8707).

## 6. Kill switches

**One revocation, every path.** Revoke the officer credential:

```bash
curl -s -X POST http://localhost:4100/api/credentials/officer/status \
  -H "content-type: application/json" -d '{"revoked":true}'
```

- Engage the agent again → presentation still submits fine, then
  `Authorization denied: the Finance Data Officer credential has been revoked by its issuer`
- Ask for the sensitive tool again → **this still succeeds if a token was already minted.** That
  is correct OAuth: revoking a credential stops the *next* grant, it does not reach back into a
  live token. Drop the cached token first, then the call fails and the AS refuses:

  ```bash
  docker restart trustlens-web        # the only way today — forgetToken() is not exposed
  ```

  Then: sensitive call → `401`, present → `GET /api/mcp/authorization` returns
  `the Finance Data Officer credential has been revoked by its issuer`, retry → `401`.

The presentation remains cryptographically valid in both cases. What changed is the issuer's
statement about it — checked by the relying party, because Heka's verifier does not.

Restore it (`{"revoked":false}`), then show **granularity**:

```bash
curl -s -X POST http://localhost:4100/api/credentials/acmeMcp/status \
  -H "content-type: application/json" -d '{"revoked":true}'
curl -s -X POST http://localhost:4000/api/verify -H "content-type: application/json" -d '{}'
```

Expect the MCP entry `REVOKED` and the agent still `VERIFIED`. One resource cut off, its
neighbour untouched, no catalog republished and no registry involved. Restore afterwards.

## 7. Audit

```bash
curl -s http://localhost:4000/api/audit
```

Every verification, refusal, authorization and denial, newest first, each with the evidence it
rested on.

## Leaving the stand clean

Restore anything revoked. `yarn verify:live` should end with:

```
2 verified, 1 refused
RESULT: PASS — the lookalike is refused, the genuine agent is usable
```
