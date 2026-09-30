# Why this demo exists, and how it was built

A short orientation document. Read this first; [ARCHITECTURE.md](ARCHITECTURE.md) explains how
the pieces fit, [OPERATIONS.md](OPERATIONS.md) explains how to run and debug them.

## The problem

Enterprise multi-agent ecosystems have a trust gap on two edges, and neither is solved by the
infrastructure organisations already have.

**Discovery.** An orchestrator that needs a supplier's agent can find _candidates_ — a registry
returns endpoints matching "Acme invoice". It cannot tell which of them Acme actually operates.
Existing B2B trust infrastructure (contracts, vendor onboarding, KYB) does not extend to a
directory of agent endpoints, and a relevance score is not a trust signal. This is
supplier-impersonation fraud — the BEC pattern — ported to agent discovery.

**Authorization.** Once an agent is acting, a sensitive step needs to be tied to a _human with a
role_, not merely to a session that was authenticated hours ago at some perimeter. AI tooling
tends to collapse role boundaries: the agent has whatever access it was given, for as long as it
has it.

## What the demo argues

> Before you use a resource, verify it. Before it serves you, it verifies you — in each
> protocol's own native way.

Concretely, it demonstrates that decentralized identity closes both edges without inventing a
new protocol for either:

| Gap                                  | How the demo addresses it                                                                                                                                                                                                                                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trust at counterparty discovery      | Resource Passport credentials attached to ARD catalog entries; the lookalike is refused on subject binding                                                                                                                                                                                                           |
| Relying party / verifier sovereignty | The trusted-issuer list lives in the orchestrator. The registry asserts nothing and can be swapped out                                                                                                                                                                                                               |
| Trust granularity and portability    | One credential per resource, revocable independently; one role credential works across two protocols                                                                                                                                                                                                                 |
| JIT authorization, least privilege   | The MCP path enforces scope per call — a client holding a token is still refused and told which scope it lacks                                                                                                                                                                                                       |
| Human-in-the-loop                    | The sensitive step pauses for a presentation from the operator's wallet, disclosing role and organisation only                                                                                                                                                                                                       |
| Auditability                         | Every trust decision — including refusals — is recorded with the evidence it rested on                                                                                                                                                                                                                               |
| Non-repudiation                      | **Partial.** The presentation is now retained with the decision that relied on it — claims, issuer, holder, status check and the compact VP, in the task and in the audit (about 2 KB per presentation, in memory). The log is still in-process and unsigned; see [ENHANCEMENTS](../ENHANCEMENTS.md#non-repudiation) |

## The scenario, in one pass

1. **Discovery** — searching an ARD catalog for "Acme invoice" returns three resources from two
   publishers, scoring 93 / 93 / 91. The directory cannot separate the genuine from the lookalike.
2. **Verification** — the Trust Lens resolves each `trustManifest`, fetches the Resource Passport
   and checks it. The lookalike fails `SUBJECT_MISMATCH`: its credential is genuine, signed by
   the real issuer, unexpired, on a matching domain — but issued for _Acme's_ agent.
3. **A2A engagement** — the verified agent reconciles invoices and pauses at the payment export
   with an OID4VP request. The operator presents a Finance Data Officer credential; the task
   completes.
4. **MCP access** — a routine tool answers freely; the sensitive one answers `401` naming the
   scope it needs (`403 insufficient_scope` if a token exists but lacks it). The client steps up
   through the MCP spec's own chain and the authorization server mints a short-lived scoped token
   against _the same credential_.
5. **Kill switches** — revoking the officer credential denies both protocol paths. Revoking one
   Resource Passport removes one resource and leaves its neighbour usable.
6. **Audit** — the chronology of every decision, with evidence.

## How it was built

Work ran in phases, each ending in something demonstrable. The order was chosen so that the
riskiest unknowns were settled before anything was built on them.

| Phase                             | Goal                                                  | Outcome                                                                                                                                                                                 |
| --------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 — De-risking**                | Settle the three unknowns before writing product code | Revocation proven end to end (`yarn derisk`); ARD v0.9 pinned in [ADR-001](../spec/ADR-001-field-decisions.md); registry surveyed in [ADR-002](../spec/ADR-002-registry-integration.md) |
| **1 — Identities and publishers** | Everything the demo publishes                         | `yarn seed`: four `did:hedera`, issuer, status list, cards, passports, catalogs — each layer digest-bound to the one below. Publisher sites over HTTPS                                  |
| **2 — Verification (M1)**         | The part that decides trust                           | `src/core` engine, all nine verdicts unit-tested; Trust Lens UI with discovery, evidence and audit                                                                                      |
| **3 — A2A (M2)**                  | Human-in-the-loop authorization                       | Agent pauses on `auth-required`, resumes on a verified presentation, refuses a revoked credential                                                                                       |
| **4 — MCP + console (M3)**        | Second protocol, and the issuer's side                | OAuth 2.1 resource server, AS with an OID4VP interaction, TrustCo Console                                                                                                               |
| **5 — MCP as a real transport**   | The MCP path driven by a model                        | Streamable HTTP server, the SDK client with an OAuth provider, a per-call verification gate, and a chat whose tool call pauses for the person. The LLM is optional everywhere else      |

Two unknowns turned out to matter more than expected and are worth knowing about:

- **Heka issues credentials only through OID4VCI offers.** There is no "sign this and return the
  bytes" endpoint, and the issuance session does not retain them. Resource Passports must be
  published as static files, so the seed claims its own offers with a throwaway holder
  (`src/shared/holder.ts`).
- **Heka's verifier does not check revocation.** It confirms a presentation is cryptographically
  sound; whether the credential is still valid is left to the relying party. Both the agent and
  the authorization server therefore check the status list themselves. Without that, revoking the
  officer credential would deny nothing.

## What is not built

- **Registry ingestion.** The demo names [mcp-gateway-registry](https://github.com/agentic-community/mcp-gateway-registry)
  as its discovery layer, and it cannot currently run — see [ADR-002](../spec/ADR-002-registry-integration.md)
  for the chain of upstream problems, ending in an nginx template that is out of sync with its
  generator. Discovery reads the publishers directly instead, returning the same shape the
  registry contract does. This costs realism, not trust: the registry is a directory, and every
  verdict re-fetches from the publisher regardless.
- **Production hygiene.** Development keys are committed, credential state is in memory, and the
  AS has no consent screen beyond the presentation itself.
