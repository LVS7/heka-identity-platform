# Architecture

How the pieces fit, and which properties must survive any change. Read [GOAL.md](GOAL.md) first
for why this exists.

## Cast

Four parties, mirroring a real supply relationship.

| Party                                | Identity                      | Role                                                                                                                         |
| ------------------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **TrustCo**                          | `did:hedera` (seeded)         | Certification body. Issues Resource Passports and the officer role credential; owns the status list                          |
| **Acme** (`acme-invoices.example`)   | one `did:hedera` per resource | Genuine publisher of two independent resources: an A2A agent and an MCP server                                               |
| **Pro** (`acme-invoices-ai.example`) | its own `did:hedera`          | Lookalike publisher. Spec-valid catalog, plausible domain, and a **genuine** TrustCo credential that belongs to Acme's agent |
| **Operator**                         | wallet holder binding         | The human. Holds a Finance Data Officer credential                                                                           |

Acme's two resources are deliberately modelled as **independent**: separately listed, separately
attested, separately revocable. That is what makes per-resource granularity demonstrable.

## Components

```
                    ┌──────────────────────┐
                    │  Heka Identity Svc   │  issuer · verifier · status lists
                    └──────────┬───────────┘
                               │ OID4VCI / OID4VP / status list
        ┌──────────────────────┼───────────────────────┬─────────────────┐
        │                      │                       │                 │
┌───────┴───────┐   ┌──────────┴────────┐   ┌──────────┴──────┐   ┌──────┴──────┐
│ Publisher     │   │ Acme Invoice      │   │ Authorization   │   │  TrustCo    │
│ sites         │   │ Agent (A2A)       │   │ Server          │   │  Console    │
│ src/sites.ts  │   │ src/agent         │   │ src/mcp/auth-*  │   │ src/console │
└───────┬───────┘   └──────────┬────────┘   └────────┬────────┘   └─────────────┘
        │ catalogs             │ A2A                 │ OAuth 2.1
        │ cards                │                     │
        │ attestations         │            ┌────────┴────────┐
        │                      │            │ Acme Invoice    │
        │                      │            │ Data (MCP RS)   │
        │                      │            │ src/mcp/server  │
        │                      │            └────────┬────────┘
        └──────────┬───────────┴──────────────────────┘
                   │
          ┌────────┴─────────┐
          │   Trust Lens     │  src/web  — the orchestrator
          │  ┌────────────┐  │
          │  │ src/core   │  │  verification engine + audit log
          │  └────────────┘  │
          └──────────────────┘
```

`src/core` is deliberately dependency-light: it decides verdicts and knows nothing about Credo,
Express or Heka. External capabilities (DID resolution, SD-JWT verification, HTTP) are injected,
which is what makes the whole decision table unit-testable without a network.

## The trust chain

Each layer is digest-bound to the one below, so nothing can be swapped after attestation:

```
ai-catalog.json
  └─ entry.trustManifest.attestations[].digest  ──►  the hosted SD-JWT bytes
                                                        └─ resource_card_digest  ──►  the served card
                                                        └─ resource_did          ──►  must equal trustManifest.identity
                                                        └─ operator.domain       ──►  must equal URN FQDN and serving domain
                                                        └─ credentialStatus      ──►  live status list
```

`yarn seed` builds this bottom-up: cards first, then passports pinning the cards, then catalogs
pinning the passports.

## Verification procedure

`src/core/verify.ts`, in order, short-circuiting on the first failure:

1. URN publisher FQDN equals the domain the catalog was served from
2. `trustManifest.identity` resolves (did:hedera)
3. attestation fetched, digest matches, SD-JWT signature and validity window verified
4. issuer is in this relying party's trusted list
5. subject binding · operator domain · resource card digest
6. status list — is the credential revoked right now

Verdicts: `VERIFIED`, `NO_ATTESTATION`, `UNTRUSTED_ISSUER`, `SUBJECT_MISMATCH`,
`OPERATOR_DOMAIN_MISMATCH`, `DIGEST_MISMATCH`, `EXPIRED`, `REVOKED`, `NO_STATUS` (no status pointer: a credential that cannot be revoked is not relied on).

The lookalike fails at **step 5**, having passed 1–4. That is the demo's central point: signature,
issuer trust, domain anchoring and digests all hold. Only the subject binding separates them.

## Authorization paths

Both paths gate on the **same** Finance Data Officer credential, through different mechanisms.

**A2A** (`src/agent`) — the agent creates a verification session, returns `auth-required` carrying
the OID4VP request in `message.metadata[<extension URI>]`, and resumes when the session reaches
`ResponseVerified`.

**MCP** (`src/mcp`) — the resource server answers `401` (then `403 insufficient_scope` once a
token exists but lacks the scope), naming the scope in `WWW-Authenticate`. The client walks
RFC 9728 → RFC 8414 → authorization with PKCE and an RFC 8707 resource indicator. Where a login
form would be, the AS runs an OID4VP presentation, then mints a ~5 minute JWT carrying the
verified role, audience-bound to that MCP server.

The MCP server and client know nothing about verifiable credentials. That is the point: the
composition needs no bespoke wire format, so an ordinary MCP client still works.

## Invariants

Break these and the demo stops being an argument. If a change appears to require it, the change
is wrong.

1. **Verification runs in the orchestrator, never in the registry.** ARD §7.2 assigns trust
   evaluation to the consumer, and relying parties choose their own anchors.
2. **No verdict may depend on registry-held data.** Every input is re-fetched from the publisher.
   This is what makes the registry replaceable — and why running without one costs nothing.
3. **Relevance is never trust.** Wherever a score is shown, the ARD wording travels with it.
4. **The relying party checks revocation — of the credential that was presented.** Heka's verifier
   does not consult the status list and does not constrain the issuer. Any new protocol path must
   evaluate the presented credential itself (`src/shared/presented-credential.ts`), or its kill
   switch is decorative.
5. **Fail closed.** Unreadable status list, unresolvable DID, unreachable card → refuse. A refusal
   is a trust decision and gets an audit entry.
6. **Refusals are auditable.** Engaging a non-VERIFIED resource is refused _and recorded_, not
   silently dropped.
7. **Simulation is labelled.** The in-process holder is an affordance for development; who
   presented a credential is exactly what the demo is about, so it says so in the UI and the audit.

## Layout

```
src/
  core/         verdicts, digests, status lists, audit — no I/O frameworks, fully unit-tested
  web/          Trust Lens: discovery, verification, A2A task tracking, MCP client, static UI
  agent/        Acme Invoice Agent (A2A + In-Task Auth)
  mcp/          MCP resource server and the OAuth 2.1 authorization server
  console/      TrustCo Console
  shared/       Heka client, Credo holder/verifier agents, simulated wallet, demo cast
  seed/         seed state and card/catalog builders
  scripts/      de-risking and live-verification scripts
static/         generated publisher content (committed so the repo is browsable)
spec/           pinned upstream specs and ADRs
docs/           this documentation
```

## Where decisions are written down

- [ADR-001](../spec/ADR-001-field-decisions.md) — pinned ARD version, field names, why the VC
  attestation profile is a _proposal_, why revocation is app-layer
- [ADR-002](../spec/ADR-002-registry-integration.md) — registry integration, what blocks it, and
  the fallback the demo ships on
- [REVOCATION-AUDIT](REVOCATION-AUDIT.md) — what the revocation audit found, what was fixed, what
  was accepted
- Commit messages carry the reasoning for individual changes; `git log` on this directory is a
  usable narrative.
