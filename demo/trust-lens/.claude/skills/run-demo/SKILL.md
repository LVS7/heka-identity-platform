---
name: run-demo
description: Use when bringing the Trust Lens demo stack up or down - starting Heka, seeding, and launching the publisher sites, agent, authorization server, MCP server, Trust Lens and TrustCo Console. Covers the Docker/Windows setup, the loopback bridge and start ordering.
---

# Bringing the demo up

## Decide what you actually need

Starting everything is rarely required, and the full stack plus an emulator does not fit in 16 GB.

| Working on               | Needs                                           |
| ------------------------ | ----------------------------------------------- |
| Discovery / verification | Heka, sites, web                                |
| A2A path                 | + agent                                         |
| MCP path                 | + AS, MCP server                                |
| Revocation               | + console                                       |
| Registry integration     | see `spec/ADR-002` — currently blocked upstream |

## Order

The Identity Service must be **healthy** before seeding, and before the agent or AS start (both
call `prepare-wallet` at boot).

```
Heka  →  yarn seed (once)  →  sites  →  agent · AS · MCP  →  web · console
```

## 1. Heka Identity Service

```bash
cd ../../heka-identity-service
docker compose -f docker-compose.dev.yml up -d
```

Wait for health, then confirm:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/health
```

Must be `200`. If it is `302`, something else owns port 3000 — most likely Grafana from the
registry stack. Stop it.

⚠️ Never `docker compose down` this stack casually: its Postgres has no named volume, so `down`
destroys the issuer, DIDs and status list that `.seed-state.json` still points at. If it happens,
`yarn seed --reset`.

## 2. Seed (first run, or after a wipe)

```bash
yarn seed          # idempotent — keeps DIDs
yarn seed --check  # is the state complete
yarn seed --reset  # re-issue everything (minutes; writes to Hedera testnet)
```

It prints a credential offer at the end. For a real wallet, prefer the Console's **Send offer to
wallet** (a fresh offer over DIDComm) — see `wallet-flow`. To let a phone or emulator reach Heka
without `adb reverse`, start Heka with `AGENT_OID4VCI_EP=http://<LAN-IP>:3003` (step 1 there);
no re-seed is needed after changing it.

## 3. Services

On Linux/macOS with Node 22, `yarn sites`, `yarn agent`, `yarn as`, `yarn mcp`, `yarn web`,
`yarn console`, each in its own terminal. On Windows use containers — native askar will not build
without MSVC.

### Container pattern

```bash
docker network create trustlens-net   # once
```

Common arguments (adjust the absolute path):

```
-v "<repo>/demo/trust-lens:/app" -v trustlens_node_modules:/app/node_modules -w /app
--network trustlens-net --add-host=host.docker.internal:host-gateway
node:22-bookworm
```

**The loopback bridge.** Heka mints OID4VC offers and OID4VP requests pointing at
`http://localhost:3003`; inside a container that is the container itself. Any container that
claims or presents a credential — seed, agent, AS, web — must start with:

```bash
(apt-get update -qq && apt-get install -y socat) >/dev/null 2>&1
socat TCP-LISTEN:3000,fork,reuseaddr,bind=127.0.0.1 TCP:host.docker.internal:3000 &
socat TCP-LISTEN:3003,fork,reuseaddr,bind=127.0.0.1 TCP:host.docker.internal:3003 &
sleep 2
```

### Per-service specifics

**Publisher sites** — must answer to the demo domains, or nothing resolves:

```
--name trustlens-sites -e SITES_PORT=443
--network-alias acme-invoices.example --network-alias acme-invoices-ai.example
```

**Agent** — the Trust Lens connects to the URL _in the published agent card_, which the seed
writes from `ACME_AGENT_URL`. Seed with `ACME_AGENT_URL=http://trustlens-agent:10003/` (and
`MCP_PUBLIC_URL=http://trustlens-mcp:4400`) in containers; the agent's own card uses:

```
--name trustlens-agent -p 10003:10003
-e ACME_AGENT_PORT=10003 -e ACME_AGENT_PUBLIC_URL=http://trustlens-agent:10003/
```

**Authorization server** (needs the bridge — it runs OID4VP):

```
--name trustlens-as -p 4300:4300 -e AS_PORT=4300 -e AS_PUBLIC_URL=http://trustlens-as:4300
```

**MCP server** (no bridge needed — it only validates JWTs):

```
--name trustlens-mcp -p 4400:4400
-e MCP_PORT=4400 -e MCP_PUBLIC_URL=http://trustlens-mcp:4400 -e AS_PUBLIC_URL=http://trustlens-as:4300
```

**Trust Lens** (needs the bridge — hosts the simulated holder):

```
--name trustlens-web -p 4000:4000
-e SITES_PORT=443 -e TRUST_LENS_WEB_PORT=4000
-e ACME_AGENT_URL=http://trustlens-agent:10003 -e MCP_PUBLIC_URL=http://trustlens-mcp:4400
```

**Console** (needs the bridge — it mints offers):

```
--name trustlens-console -p 4100:4100 -e TRUSTCO_CONSOLE_PORT=4100
```

**Wallet link.** Delivery to the wallet is outbound only — no DIDComm port is opened, so none
needs a `-p`. The link itself lives in `.wallet-link.json` in the repo directory, so both
containers see it through the mount.

## 4. Confirm it is actually up

```bash
curl -s "http://localhost:4000/api/discovery?q=Acme%20invoice"   # 3 results
curl -s http://localhost:4100/api/credentials                    # 3 credential tiles
curl -s -X POST http://localhost:4400/mcp -H "content-type: application/json" -H "accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length'   # 2
curl -s http://localhost:4000/api/chat | jq '{available, model}'   # true, "gpt-4o-mini" (false without a key)
curl -s http://localhost:10003/health                            # {"ok":true,…,"channel":{"state":"open",…}}
```

`GET /api/mcp/tools` answers 403 until the MCP entry is engaged (Discovery → Verify all → Engage
_Acme Invoice Data_, or `POST /api/engage` with its identifier).

Then `yarn verify:live` — the fastest real confidence check, exercising did:hedera resolution,
SD-JWT verification, digests and status lists in one pass. Expect `VERIFIED`, `VERIFIED`,
`SUBJECT_MISMATCH`.

## Bringing it down

Containers run with `--rm`, so `docker rm -f` removes them; re-create rather than `docker start`.
Leave Heka running unless memory is needed — restarting it is cheap, wiping it is not.
