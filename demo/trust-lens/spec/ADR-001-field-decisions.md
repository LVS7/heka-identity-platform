# ADR-001: Pinned specs and field decisions

Status: accepted (Phase 0.3)

## Pinned upstream specs

| Spec | Version pinned | Source |
|---|---|---|
| Agentic Resource Discovery (ARD) | **v0.9 (draft)**, read 2026-08-20 | [ards-project/ard-spec](https://github.com/ards-project/ard-spec) — text in `spec/ard.md`, schemas in `spec/schemas/` (JSON Schema / CDDL / OpenAPI), conformance tooling in `conformance/` |
| OID4VP In-Task Authorization Extension for A2A | v1 | [a2aproject/experimental-ext-oid4vp-auth](https://github.com/a2aproject/experimental-ext-oid4vp-auth) |
| Registry implementation | mcp-gateway-registry, ARD v1.0 end-to-end (Publisher + Registry + federation) | [agentic-community/mcp-gateway-registry](https://github.com/agentic-community/mcp-gateway-registry), `docs/ard.md` |

## What the ARD spec fixes for us (verified, not assumed)

- **Manifest location**: `https://{domain}/.well-known/ai-catalog.json`.
- **Entry identifier**: domain-anchored URN `urn:air:<publisher-FQDN>:<namespace>:<name>`. (The `urn:ai:` form seen in some drafts is not the one we use.)
- **Entry required fields**: `identifier`, `displayName`, `type`; exactly one of `url` **xor** `data`. Optional: `description`, `tags`, `capabilities`, `representativeQueries` (2–5 samples), `version`, `updatedAt`, `metadata`, `trustManifest`.
- **Media types**: `application/a2a-agent-card+json`, `application/mcp-server-card+json`, `application/ai-catalog+json` (nested), `application/ai-registry+json` (registry endpoint).
- **trustManifest** (§5.1): `identity` (required — SPIFFE ID, DID or HTTPS FQDN URI), `identityType`, `attestations[]`, `provenance[]`, `signature` (detached JWS).
- **Attestation object** (§5.2): `type` (required), `uri` (required), `digest` (optional).
- **Search** (§7.2): `POST /search` with `{query:{text,filter},federation,pageSize,pageToken}` → results carrying `score` (0–100) and `source`.

Two normative statements carry the demo's whole argument:

> "The cryptographic trust domain inside this identity MUST align with the authority domain root embedded in the discovery identifier namespace." (§5.1)

> "The score parameter … is strictly an informational relevance metric and MUST NOT be interpreted by orchestrators as a cryptographic trust, compliance, or safety rating. Trust evaluation is fully decoupled and handled independently via the verification procedures in the trustManifest layer." (§7.2)

## Decisions

1. **URN namespace** — use `urn:air:<publisher-FQDN>:<namespace>:<name>` as the spec mandates.

2. **VC attestations are a proposed profile, not spec-blessed.** The spec's `attestations[].type` examples are compliance labels (`SOC2-Type2`, `HIPAA-Audit`, `SPIFFE-X509`, `GDPR`) and are explicitly non-exhaustive. Our `application/vc+sd-jwt` value, with `uri` dereferencing to an SD-JWT VC and `digest` covering the fetched bytes, is the demo's **VC Attestation Profile for ARD** — an additive convention that stays structurally conformant. Documented as a proposal, not as existing spec.

3. **Domain alignment via issuer-attested operator domain.** `did:hedera` does not structurally encode a publisher domain, so the §5.1 alignment requirement is satisfied through the Resource Passport's `operator.domain` claim, attested by an issuer the relying party already trusts, checked against **both** the URN publisher FQDN and the serving domain. DIF Well-Known DID Configuration remains the documented issuer-independent alternative (not built here).

4. **Credential format**: SD-JWT VC. Heka's issuer config takes `format: "vc+sd-jwt"` with a `vct`; accept legacy `vc+sd-jwt` alongside `dc+sd-jwt` when parsing.

5. **Revocation is app-layer** (design decision D7). Heka Identity Service does not embed a `credentialStatus` pointer in issued SD-JWT VCs (its status-list indexing covers JwtVcJson / JwtVcJsonLd / LdpVc only) and its verifier does not check status automatically. We therefore put `credentialStatus: {statusListCredential, statusListIndex}` into the credential payload at issuance (payloads are arbitrary objects — verified against a live instance) and check the public Bitstring Status List in the relying party. Proven end to end by `yarn derisk`.

6. **Verification lives in the orchestrator**, never in the registry — per §7.2 above and the SSI principle that relying parties choose their own trust anchors. The registry stays a neutral discovery layer.

## Registry integration constraints (mcp-gateway-registry)

Its ARD ingestion crawler applies, on top of the shared SSRF guard (`registry/services/ard_net_guard.py`):

- **HTTPS is mandatory** (`require_https=True`).
- **Loopback / private IPs are denied** unless the host is allowlisted. ARD ingestion uses `SKILL_PROFILE`, whose allowlist comes from the `GITHUB_EXTRA_HOSTS` setting (not `SSRF_ALLOWED_HOSTS`, which serves the proxy profile).
- **Publisher-domain anchoring**: an ingested entry's URN publisher FQDN is anchored to the configured source identity (`expected_identity` pin → `domain` → host of `uri`), with `trust_enforcement` of `reject` (default) / `flag` / `off`.

Consequence for local development: publisher sites served on `*.localhost` need both the hostname allowlisted for the crawler and TLS the registry trusts, or the entries are registered through the registry's management API instead (the adapter still crawls our catalogs; the registry stays the search surface). Decided in Phase 0.1.
