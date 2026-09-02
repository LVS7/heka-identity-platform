# Enhancements

Proposals, not defects. A defect gets fixed and disappears; what is listed here is work the demo
would be better for, deliberately left undone.

Two entries close gaps against the assignment and are therefore not optional in the same sense as
the rest — they are marked. The full honest account of what the demo does and does not deliver is
in [docs/GOAL.md](docs/GOAL.md); this file is about _how to close_ what is open there.

|     | Enhancement                                                                                                       | Closes an assignment gap |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 1   | [Non-repudiation](#non-repudiation)                                                                               | **yes**                  |
| 2   | [Registry ingestion](#registry-ingestion)                                                                         | **yes**                  |
| 3   | [A way to drop the access token](#a-way-to-drop-the-access-token)                                                 | no                       |
| 4   | [Finish a pending authorization instead of orphaning it](#finish-a-pending-authorization-instead-of-orphaning-it) | no                       |
| 5   | [Stage the five verdicts nobody can see](#stage-the-five-verdicts-nobody-can-see)                                 | no                       |
| 6   | [Widen the presentation window](#widen-the-presentation-window)                                                   | no                       |
| 7   | [Run typecheck and tests on every change](#run-typecheck-and-tests-on-every-change)                               | no                       |
| 8   | [Render the QR locally and show the raw request](#render-the-qr-locally-and-show-the-raw-request)                 | no                       |

---

## Non-repudiation

**Closes an assignment gap.** The brief asks for "auditability / non-repudiation". The demo
delivers the first word.

**What exists.** Every trust decision — verification, refusal, authorization, denial — is appended
to an audit log with the evidence it rested on, and refusals are recorded rather than dropped.

**What is missing.** Three things, each of which is what "non-repudiation" actually means:

- The log lives in process memory. Restarting the Trust Lens erases it. This was not theoretical:
  a restart during a walkthrough took the whole A2A run with it.
- Nothing is signed. An audit record that anyone can rewrite proves nothing to a third party.
- The verifiable presentation is discarded once verified. The one artifact that carries the
  holder's own signature — the thing that makes a claim undeniable — is thrown away at the exact
  moment it becomes evidence.

**What it takes.** Persist the log; retain the compact VP alongside the decision that relied on
it; sign each record with the relying party's key so the chain can be checked later by someone who
was not there. None of this is large — `src/core/audit.ts` is already an append-only structure, so
the shape is right and only the durability and the signature are absent.

**What it buys.** The difference between "our system says it checked" and "here is the holder's
signature over the claim, and here is our countersigned record of acting on it". Only the second
survives a dispute, which is the entire reason to prefer verifiable credentials over bearer
tokens.

---

## Registry ingestion

**Closes an assignment gap.** [mcp-gateway-registry](https://github.com/agentic-community/mcp-gateway-registry)
is named in the brief as the discovery layer and is not wired in.

**What exists.** Discovery crawls the publishers directly and returns the shape the ARD registry
contract returns — entries with a relevance score and a source.

**What is missing.** The real registry. It does not currently run: the published image ships
without nginx, and a source build needs CRLF normalisation before hitting an nginx template that
is out of sync with its own generator. The chain of evidence is in
[spec/ADR-002](spec/ADR-002-registry-integration.md).

**What it takes.** Either an upstream fix (the template/generator mismatch is a small, specific
bug worth reporting) or pinning a release where it holds together. Then the adapter in
`src/ard-adapter` ingests `ai-catalog.json` into the gateway and discovery reads from there.

**What it buys.** Realism, not trust. Every verdict re-fetches from the publisher regardless — the
registry cannot change an outcome, which is the invariant the demo is built on. What it would
prove is that the trust layer composes with a directory somebody else wrote.

---

## A way to drop the access token

**Why.** The MCP kill switch is real but awkward to show. Revoking the officer credential stops
the authorization server minting a _new_ token; a token already issued stays valid for the rest of
its five minutes, exactly as OAuth intends. To demonstrate the denial you must first get rid of
the cached token, and today the only way is `docker restart trustlens-web`.

`McpClient.forgetToken()` already exists in `src/web/mcp-client.ts` — it is simply never called
from anywhere and not exposed.

**What it takes.** A `DELETE /api/mcp/token` route and a button beside the TTL countdown.

**What it buys.** The most persuasive step in the demo stops requiring a container restart in
front of an audience.

---

## Finish a pending authorization instead of orphaning it

**Why.** Calling a scoped tool while an authorization is already pending starts a second one and
abandons the first. The flow still works — the client completes the exchange when polled — but the
authorization server accumulates requests that will never be answered, and a viewer reading its log
sees `awaiting a presentation` lines that look like failures and are not.

**What it takes.** In `callTool`, check for a pending grant and try to complete it before starting
a fresh step-up.

**What it buys.** The log stops lying about what happened, and the order of client calls stops
mattering.

---

## Stage the five verdicts nobody can see

**Why.** The engine distinguishes eight verdicts and all eight are unit-tested, but only three —
`VERIFIED`, `SUBJECT_MISMATCH`, `REVOKED` — can be produced on a running stand. `UNTRUSTED_ISSUER`,
`EXPIRED`, `DIGEST_MISMATCH`, `OPERATOR_DOMAIN_MISMATCH` and `NO_ATTESTATION` exist only in tests.

That matters more than it sounds. The lookalike in the scenario is caught by subject binding, but
a different attacker — one who gets a genuine passport for their own DID from an issuer nobody
trusts — is caught by a check the demo never demonstrates.

**What it takes.** Seed flags that publish deliberately broken variants (a passport from an
untrusted issuer, one with a stale card digest, one already expired), and a way to select them in
the UI.

**What it buys.** The verification engine stops being taken on faith. Right now a viewer sees one
attack defeated and has to believe the rest.

---

## Widen the presentation window

**Why.** The OID4VP verification session expires after Credo's default window and the Heka API
does not expose `expirationInSeconds`. A person who reads the consent screen before approving it
can lose the race, and the working practice — create the request and deliver it in one step, tap
immediately — is fine for a rehearsed demo and hostile to a first-time user.

**What it takes.** Upstream: expose the session lifetime on
`POST /openid4vc/verification-session/request` in the Identity Service. Here: set it explicitly
alongside the agent's own timeout so the two are visibly derived from one number.

**What it buys.** A human can behave like a human. This is a demo about human-in-the-loop
authorization, so a timeout that punishes reading the request contradicts the point.

---

## Run typecheck and tests on every change

**Why.** `yarn typecheck` was added only after `tsc` was run for the first time and reported
eleven errors across seven files — among them a `LogLevel` member that does not exist (so
`CREDO_LOG_DEBUG=1` had never worked), a catalog field present in the data and absent from its
type, and an agent type that claimed to have no modules. None of it was caught, because nothing
ran.

**What it takes.** A workflow that runs `yarn typecheck` and `yarn test` on push. Both are already
scripts and both are fast.

**What it buys.** The class of defect above stops accumulating silently between sessions.

---

## Render the QR locally and show the raw request

**Why.** The UI turns an OID4VP authorization request into a QR code by handing it to a third-party
service:

```js
el('auth-qr').src =
  `https://api.qrserver.com/v1/create-qr-code/?…&data=${encodeURIComponent(task.authorizationRequest)}`
```

Two consequences. The request URI — `client_id` and the `request_uri` the wallet will fetch —
leaves the machine and goes to a SaaS that has nothing to do with the demo. Nothing sensitive is
disclosed (the `request_uri` points at localhost and is useless to anyone else, and the credential
never travels this way), but a demo whose argument is _decentralized_ identity should not route its
authorization requests through a random external renderer, and the UI silently needs internet to
show a QR at all.

The second consequence is practical: the raw URI is never rendered, and there is no endpoint that
lists tasks, so once the QR is on screen the request cannot be recovered. On an emulator, where
there is no camera to scan with, that makes the Engage button unusable — the whole step has to be
driven from the command line instead, which the README now explains at length because the UI
cannot.

**What it takes.** Generate the QR client-side from a vendored library, and print the URI next to
it as selectable text with a copy button.

**What it buys.** The demo stops depending on an external service and works offline; the emulator
path stops needing a shell; and the walkthrough's "scan this" step becomes true for every device
instead of only for a phone with a camera.
