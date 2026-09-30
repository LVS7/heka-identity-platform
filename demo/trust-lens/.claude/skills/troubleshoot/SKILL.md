---
name: troubleshoot
description: Use when something in the Trust Lens demo is broken - a service will not start, a verdict is wrong, a presentation fails, or a credential flow errors. Maps observed symptoms to the causes actually encountered, with the check that confirms each.
---

# Diagnosing

Every entry below was hit for real. Match the symptom, run the check, apply the fix. If nothing
matches, the bottom section has the general approach.

## Start here

Two checks catch most breakage in under a minute:

```bash
curl -s -o /dev/null -w "heka %{http_code}\n" http://localhost:3000/health   # must be 200
yarn seed --check                                                            # must report complete
```

`302` from Heka means something else owns port 3000 — usually Grafana from the registry stack.
An incomplete seed after a working session usually means Heka's database was wiped.

## Symptoms

### `server_error` from issuance · issuer not found · DIDs that no longer resolve

**Heka's database was wiped.** Its dev compose gives Postgres no named volume, so
`docker compose down` destroys the issuer, DIDs and status list while `.seed-state.json` still
references them.

```bash
yarn seed --reset
```

Anything already in a wallet is now stale — re-issue with a fresh offer.

### `session expired` when presenting

The OID4VP session expired before the presentation arrived. Heka does not expose
`expirationInSeconds`, so the window cannot be widened.

Have the wallet unlocked and in the foreground before **Send to wallet**, and tap Share at once.
Nothing is corrupted — **Resend to wallet** or engage again. See `wallet-flow`.

### `no wallet linked`

`GET /api/wallet` says `linked: false`. Paste the wallet's `Public DID: did:peer:…` (React Native
DevTools, or `adb logcat -d -s ReactNativeJS`) into the header of the Trust Lens or the Console. The link is `.wallet-link.json`.

### Sent to the wallet, nothing on the phone

In order: wallet in the background or on the PIN screen (bring it up); DID from a previous
install (re-link with the current `Public DID`); no internet to the mediator on one side; the
wallet rejected it (wallet log). `[wallet-link] delivered …` in the sender log proves the message
left; the receiver's log proves it arrived. See `docs/OPERATIONS.md`.

### `no did-communication service` when linking

Not a wallet DID. Credo 0.7 delivers only to `did-communication`/`IndyAgent` services and drops
DIDComm v2 `DIDCommMessaging`; the link step checks up front.

### `Network request failed` in the wallet

The device cannot reach Heka. Advertise the host's LAN address
(`AGENT_OID4VCI_EP=http://<LAN-IP>:3003 docker compose -f docker-compose.dev.yml up -d heka-identity-service`;
no re-seed needed) or, emulator only, `adb reverse tcp:3003 tcp:3003`. A changed network means a
changed address — repeat.

### `no presentation was received in time`

The agent's own timeout (`AGENT_AUTH_TIMEOUT_MS`, default 180s) — distinct from the session
expiring, same practical cause.

### Every entry turns `NO_ATTESTATION` with `no such table: items`

The verifier's Askar store evaporated. `inMemory: true` puts the database _inside the pooled
connection_, so when the pool retires that connection the replacement opens an empty one —
observed about twenty minutes into an idle stand, and it looks like a Hedera or network problem
because DID resolution is what fails.

Fixed by `ephemeralSqliteStore()` in `src/shared/askar-store.ts`, which uses a file in a
per-process temp directory. If this reappears, something has gone back to `inMemory`:

```bash
grep -rn "inMemory" src/
```

Restarting the service is a workaround, not a fix — it comes back.

### `no such table: profiles`

An Askar in-memory SQLite store with a pool larger than one connection: the connection that
provisions the schema is not the one that reads it. Every agent here must use:

```ts
config: { inMemory: true, maxConnections: 1, minConnections: 1 }
```

### `ERR_PACKAGE_PATH_NOT_EXPORTED` for `@verifiables/request-converter`

An ESM-only transitive dependency of Credo 0.7 whose exports map has no `default` condition.
`scripts/patch-esm-exports.mjs` fixes it on postinstall:

```bash
node scripts/patch-esm-exports.mjs
```

### `fetch failed` when engaging the agent

The A2A client connects to the URL **in the agent card**, not the one it was handed. Under Docker
that must be the container address:

```bash
docker exec trustlens-web sh -lc "curl -s -o /dev/null -w '%{http_code}\n' http://trustlens-agent:10003/.well-known/agent-card.json"
```

If that is `200` but engagement still fails, the card is advertising `localhost`. Set
`ACME_AGENT_PUBLIC_URL=http://trustlens-agent:10003/`.

### A container cannot reach `localhost:3003`

Expected — that is the container's own loopback. Heka's offers and requests point there, so any
container that claims or presents a credential needs the socat bridge (`run-demo`).

### Every presentation is refused as "outside the issuer's service"

**The relying party and the seed disagree about Heka's address.** The agent and the
authorization server compare the origin of the credential's `statusListCredential` with the
origin of their own `IDENTITY_SERVICE_URL`. The pointer was written at seed time from the seed's
`IDENTITY_SERVICE_URL`; a container given `host.docker.internal` or `127.0.0.1` instead of
`localhost` fails closed here even though both reach the same Heka. The refusing log names both:

```bash
docker logs trustlens-agent 2>&1 | grep "status list origin"   # [agent] status list origin … is not …
```

Give the seed and every relying party the same `IDENTITY_SERVICE_URL` value — the socat bridge
exists for exactly this, so containers can keep `http://localhost:3000`.

### Publisher domains do not resolve from a container

Check the aliases:

```bash
docker inspect trustlens-sites --format '{{range $k,$v := .NetworkSettings.Networks}}{{$v.Aliases}}{{end}}'
```

If the domains ever get changed back to `.localhost`, they will never resolve: RFC 6761 makes that
name special and resolvers hard-map it to loopback, whatever Docker DNS says. Keep `.example`.

### One entry fails with `DIGEST_MISMATCH`

The served bytes no longer match what the catalog pins — normally because a card or attestation
was edited by hand, or the seed ran partially. Re-run `yarn seed`; it rewrites the whole chain
bottom-up.

### Everything returns `REVOKED`

Either the credentials really are revoked (`curl -s http://localhost:4100/api/credentials`) or the
status list is unreadable and the engine is failing closed — which is correct behaviour. Check
`evidence.statusListChecked`: `false` means unreachable, not revoked.

### Heka exits with `EAI_AGAIN … postgres`

Its compose network is confused. `docker compose down && up -d` on the Identity Service — and
remember that wipes the database, so re-seed.

### Emulator shows `Process system isn't responding`

The emulator is starved of RAM. Free some (the registry stack and IDEs are the usual culprits) and
cold-boot it. Tapping `Wait` only postpones it.

### Registry will not start

Known and documented — see `spec/ADR-002-registry-integration.md`. Short version: the published
image has no nginx (so `/api/` can never authenticate), and a source build needs CRLF
normalisation of both scripts and nginx templates, after which its nginx template is still out of
sync with its generator (25 placeholders, 12 substituted). Do not spend a day on it before reading
that ADR.

## When nothing matches

1. **Read the logs on both sides of the boundary.** Most failures here are between two
   components, and each side tells half the story: agent + wallet, AS + MCP server, web + agent.
2. **Check whether the state is stale.** `.seed-state.json` outliving Heka's database is the most
   common invisible cause.
3. **Reproduce without the UI.** `yarn verify:live` exercises DID resolution, SD-JWT verification,
   digests and status lists in one pass, and prints where it stops.
4. **Prefer a real capture to a guess.** Fixtures in this repo come from live services precisely
   because assumptions about these formats were wrong more than once.
