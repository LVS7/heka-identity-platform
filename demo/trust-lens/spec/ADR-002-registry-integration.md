# ADR-002: How the demo's catalogs reach the registry

Status: accepted (Phase 0.1)

## Context

The demo needs a neutral discovery layer that returns three well-matching results for
"Acme invoice" from **two competing publishers** (genuine Acme + lookalike Pro), so that the
Trust Lens — not the registry — is what separates them. We use
[mcp-gateway-registry](https://github.com/agentic-community/mcp-gateway-registry), which
implements ARD end to end (Publisher, Registry, federation).

## What was verified on a live instance (Phase 0.1)

Booted with `./build_and_run.sh --prebuilt` (Docker):

- **ARD Publisher works.** `GET /.well-known/ai-catalog.json` returns a conformant catalog
  (`specVersion: "1.0"`, `host.trustManifest`, `urn:air:` entries).
- **Registry search** is `POST /api/ard/search` (JWT-required, access-scoped);
  `GET /api/ard/agents` browses. Results carry `score` (0–100) and `source`.
- **ARD ingestion of external catalogs exists** as a first-class feature
  (`POST /api/federation/config/default/ai_catalog/sources` + `/api/federation/ai_catalog/sync`,
  CLI `ard-ingestion-add-source` / `ard-ingestion-sync`), so we do **not** need to write a
  crawler — the plan's "ARD adapter" shrinks to configuring a source and triggering sync.

Three operational gotchas, all reproducible:

1. **Do not use `--prebuilt`: that image ships without the nginx its entrypoint expects.**
   Two consequences, the second fatal:

   - The app listens on `127.0.0.1:7860` *inside* the container while compose maps host
     `:80 → :8080`, so nothing is reachable. A socat sidecar sharing the container's network
     namespace papers over this (`--network "container:…-registry-1"`, forwarding 8080 →
     127.0.0.1:7860) and is enough to read the public catalog.
   - But `/api/**` authentication is performed by nginx's `auth_request` subrequest against
     the auth-server, which then mints the `X-Internal-Token-Registry` the app trusts. With no
     nginx there is no such token, so every API call answers `401 UNAUTHENTICATED` — including
     `POST /api/ard/search` and the federation endpoints. Neither `REGISTRY_API_TOKEN` +
     `REGISTRY_STATIC_TOKEN_AUTH_ENABLED` nor `NGINX_DISABLE_API_AUTH_REQUEST` helps, because
     the app looks for that block in a template it does not have (it logs
     "NGINX_DISABLE_API_AUTH_REQUEST enabled but could not find /api/ auth_request block").

   **Build from source** (`./build_and_run.sh`, no `--prebuilt`): that Dockerfile installs
   nginx and nginx-extras, so the auth chain works as designed. Two further things are needed
   before a source build actually runs, both found the hard way:

   - **Normalise line endings first.** Cloning on Windows rewrites the shell scripts to CRLF,
     so the image builds fine and then dies with
     `exec /app/registry-entrypoint.sh: no such file or directory` — the shebang has become
     `#!/bin/bash\r`. `find . -name '*.sh' | xargs sed -i 's/\r$//'`, then rebuild.
   - **Pre-download the embeddings model.** The published image bundles
     `sentence-transformers/all-MiniLM-L6-v2`; a source build does not, and the entrypoint
     stops after "Processing MCP Server configuration files" without it. The README documents
     the download, which pulls a multi-GB helper image.

   With those two fixed, the source build still does not start: **its nginx template and its
   template generator are out of sync at this commit.** The template carries 25 `{{…}}`
   placeholders (`docker/nginx_rev_proxy_http_only.conf`) while
   `registry/core/nginx_service.py` substitutes only 12. The rest — `REAL_IP_CONFIG`,
   `REGISTRY_ONLY_BLOCK`, `ROOT_PATH`, `VERSION_MAP`, `VIRTUAL_SERVER_BLOCKS`, the
   `PINGFEDERATE_*` and `KEYCLOAK_LOCATIONS_*` families — reach nginx verbatim, which rejects
   the config (`[emerg] unexpected "{" in nginx_rev_proxy.conf`) and the container exits.
   Blanking one placeholder just moves the error to the next. Filling in thirteen by guessing
   their intended semantics would be forking their reverse proxy on speculation, so we stopped
   there.

   Resource use, for the record, was **not** the blocker: the published stack ran healthy on
   this 16 GB machine more than once. The one OOM kill (exit 137) happened only with Heka, the
   publisher sites, the registry and two IDEs resident at the same time.

2. **Preflight rejects placeholder secrets.** `KEYCLOAK_DB_PASSWORD`,
   `KEYCLOAK_ADMIN_PASSWORD` and `GRAFANA_ADMIN_PASSWORD` must be strong values in `.env`.

3. **Ingestion is guarded** (`registry/services/ard_net_guard.py`): HTTPS is mandatory,
   loopback/private IPs are denied unless the host is allowlisted via `GITHUB_EXTRA_HOSTS`
   (ARD ingestion uses `SKILL_PROFILE`, *not* `SSRF_ALLOWED_HOSTS`), and an ingested entry's
   URN publisher FQDN is anchored to the configured source identity
   (`trust_enforcement` = `reject` | `flag` | `off`).

Resource note: the full stack (MongoDB replica set, Keycloak + its DB, OpenBao, registry,
auth-server, mcpgw, Prometheus, Grafana) is heavy. On a 16 GB machine it does not coexist
comfortably with the Heka stack plus an Android emulator — run the registry only for
discovery work.

## Decision

**Publish the demo catalogs over HTTPS on the registry's Docker network under the demo
domain names, and let the registry's own ARD ingestion crawl them.** Concretely:

- `acme-site` and `pro-site` containers get **network aliases equal to the demo domains**
  (`acme-invoices.example`, `acme-invoices-ai.example`), so the URN publisher FQDN, the
  serving domain and the configured ingestion source all agree — publisher-domain anchoring
  passes on its own terms.

  The domains are `.example`, **not `.localhost`**. RFC 6761 makes `.localhost` a special
  name that resolvers hard-map to loopback: a container asking for `acme-invoices.localhost`
  connects to itself and never reaches the publisher, whatever Docker DNS aliases say
  (observed as `connect to ::1 port 443 failed` from inside the registry). `.example` is
  reserved by RFC 2606 and carries no such treatment — and it is what the design document
  used in the first place.
- TLS via mkcert; the mkcert CA is mounted into the registry container so the crawler trusts it.
- `GITHUB_EXTRA_HOSTS` allowlists exactly those two hostnames, which is what relaxes the
  private-IP check for them (and only them).
- Host-side access keeps working because `*.localhost` resolves to loopback for the browser
  and for our own services.

This keeps the registry a genuine, unmodified ARD registry: it crawls public catalogs it was
pointed at, indexes them, and ranks by relevance only.

**Status: the demo currently ships on the fallback.** Discovery in `src/web` crawls the
configured publishers' catalogs directly and ranks them by relevance. That is deliberately the
same shape as the registry's contract — entries with a score and a source — so switching the
source of results is a change in one function, not in the trust model.

This is acceptable because of where the registry sits in the design: it is a phone book. ARD
§7.2 forbids reading its score as trust, and the Trust Lens re-fetches every catalog and
attestation from the publisher before deciding anything. Nothing the registry says can change
a verdict, so running without it costs discovery realism and nothing else.

To finish the integration on a machine with room for it: build from source with the three
fixes above, set `REGISTRY_API_TOKEN` + `REGISTRY_STATIC_TOKEN_AUTH_ENABLED=true`, then
register the two publishers as ingestion sources
(`POST /api/federation/config/default/ai_catalog/sources`) and sync
(`POST /api/federation/ai_catalog/sync`). `src/ard-adapter` is the place for that.

## Consequence for the code

`src/ard-adapter` is no longer a crawler. It becomes a thin setup/sync helper that registers
our two publishers as ARD ingestion sources and triggers a sync, plus a `sync` command for
re-indexing after `seed.ts` regenerates the catalogs.
