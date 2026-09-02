# Working on the Trust Lens demo

Orientation for an agent picking this up. Humans should start with
[README.md](README.md) and [docs/GOAL.md](docs/GOAL.md).

## What this is

A demo arguing that decentralized identity closes two trust gaps in multi-agent ecosystems:
verifying *who published* a discovered resource, and tying a sensitive step to *a human with a
role*. It is a demonstration, not a product — but the trust model is real and must stay correct.

Read in this order: [docs/GOAL.md](docs/GOAL.md) → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) →
[docs/OPERATIONS.md](docs/OPERATIONS.md). The ADRs in [spec/](spec/) hold the decisions and the
evidence behind them.

## Skills

Project skills cover the operational work. Prefer them over improvising:

| Skill | Use when |
|---|---|
| `run-demo` | bringing the stack up |
| `demo-walkthrough` | running or verifying the scenario |
| `wallet-flow` | anything involving the emulator or Heka Wallet |
| `troubleshoot` | something is broken |

## Invariants

These carry the argument. If a change seems to require breaking one, the change is wrong — say so
rather than working around it.

1. **Verification runs in the orchestrator, never in the registry.**
2. **No verdict may depend on registry-held data** — re-fetch from the publisher.
3. **Relevance is never trust.** Keep the ARD §7.2 wording next to any score.
4. **The relying party checks revocation itself.** Heka's verifier does not. A new protocol path
   without its own status check has a decorative kill switch.
5. **Fail closed** — unreadable status list, unresolvable DID, unreachable card all mean refuse.
6. **Refusals are audited**, not silently dropped.
7. **Simulation is labelled.** Who presented a credential is the subject of the demo.

## Conventions

- **English** throughout — code, comments, docs, commit messages. The demo is intended for
  open-source publication under Heka.
- **`src/core` stays dependency-light.** No Credo, no Express, no Heka client. External
  capabilities are injected, which is what keeps every verdict unit-testable without a network.
- **Comments explain *why*.** The what is in the code. Non-obvious constraints — a spec
  requirement, an upstream quirk, a deliberate trade-off — belong in a comment; anything larger
  belongs in an ADR.
- **Tests are the verdict table.** Adding a verdict means adding its case in
  `src/core/__tests__/verify.test.ts`.
- **Fixtures come from the live service.** The status-list tests use `encodedList` values captured
  before and after a real revocation. Prefer real captures over invented ones.
- **Credo is pinned at 0.7.x** to match Heka Wallet. Do not float these versions; a mismatch broke
  DIDComm delivery in the reference demo and cost a day to find.

## Before claiming something works

`yarn typecheck` and `yarn test` both have to pass. The typecheck script exists because `tsc` had
never been run against this code and, when it finally was, found eleven errors — including a
`LogLevel` member that does not exist, so a documented debug flag had never worked. Do not add a
`// @ts-expect-error` to make it quiet.

Run it. This codebase punished assumption repeatedly: the `.localhost` TLD silently routing to
loopback, an agent card advertising an unreachable URL, a wiped database behind a stale seed
state. `yarn test` is necessary and not sufficient — `yarn verify:live` exercises the parts that
actually break.

State what you ran and what it printed. If something is unverified, say which part.

## Environment

Windows hosts need containers for the server code (native askar will not build without MSVC), and
Heka's loopback URLs need a socat bridge into those containers. Details in
[docs/OPERATIONS.md](docs/OPERATIONS.md); `run-demo` handles it.

The full stack plus an emulator plus the registry does not fit in 16 GB. Run what the step needs.

## Known open items

- **Registry ingestion does not run** — upstream nginx template is out of sync with its
  generator. See [spec/ADR-002](spec/ADR-002-registry-integration.md). Discovery reads publishers
  directly, which changes nothing about trust.
- **The MCP transport is simplified** — plain HTTP with the spec's OAuth semantics rather than the
  streamable-HTTP MCP transport. The authorization story is faithful.
- **Development keys are committed** (Hedera operator, demo access token). Replace before any
  real deployment.
- **`demo/a2a-oid4vp` carries known debt** — the reference demo this one builds on. Several of its
  defects were hit and fixed here too (Credo pinning, the Askar pool, the authorization timeout).
  See [../a2a-oid4vp/TECH-DEBT.md](../a2a-oid4vp/TECH-DEBT.md); the fixes belong in a separate
  upstream change, not in this demo's history.
