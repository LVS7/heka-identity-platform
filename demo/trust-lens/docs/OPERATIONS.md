# Operations

Running the demo, and the failure modes worth recognising on sight. Every entry below was hit
during development — none of it is speculative.

## Services and ports

| Service               | Port                      | Needed for              |
| --------------------- | ------------------------- | ----------------------- |
| Heka Identity Service | 3000 (API), 3003 (OID4VC) | everything              |
| Publisher sites       | 443                       | discovery, verification |
| Acme Invoice Agent    | 10003                     | A2A path                |
| Authorization Server  | 4300                      | MCP path                |
| MCP server            | 4400                      | MCP path                |
| Trust Lens            | 4000                      | the UI                  |
| TrustCo Console       | 4100                      | revocation              |

Start order matters in one place: **the Identity Service must be up and healthy before `yarn
seed`**, and before the agent or AS start (both call `prepare-wallet` at boot).

## Running the services in containers

Containers are optional, not a Windows requirement. Askar 0.6 ships a prebuilt `aries_askar.dll`
and binds through koffi, so a host install needs no MSVC and no node-gyp — the sibling demo
`a2a-oid4vp` pins askar 0.4.3, which does compile at install time, and that is where the "Windows
needs containers" belief came from.

Use them when you would rather not install Node.js on the host, or want the services isolated. The
six copy-pasteable commands live in
[README § Running the services in containers](../README.md#running-the-services-in-containers-optional);
this section explains why they look the way they do.

⚠️ **Do not mix host and container services.** The sites container publishes no host port on
purpose, so a host-side Trust Lens cannot reach it — discovery then returns an empty result set
with no error anywhere. Pick one path for all six.

```bash
docker network create trustlens-net
```

Each service runs as `node:22-bookworm` with the repo mounted at `/app`, joined to that network.
Three details that are easy to miss:

**Git Bash rewrites container paths.** `-w /app` becomes `C:/Program Files/Git/app` and
`docker run` fails outright with "the working directory is invalid". Export `MSYS_NO_PATHCONV=1`
before the commands, and quote any `adb shell` path the same way.

**Publisher aliases.** The sites container must answer to the demo domains, or nothing resolves:

```
--network-alias acme-invoices.example --network-alias acme-invoices-ai.example
```

**Loopback bridge.** OID4VC offers and OID4VP requests minted by Heka point at
`http://localhost:3003`. Inside a container that is the container itself. Bridge it:

```bash
socat TCP-LISTEN:3000,fork,reuseaddr,bind=127.0.0.1 TCP:host.docker.internal:3000 &
socat TCP-LISTEN:3003,fork,reuseaddr,bind=127.0.0.1 TCP:host.docker.internal:3003 &
```

Any container that claims or presents a credential needs this — the seed, the agent, the AS, and
the Trust Lens (for its simulated holder).

## Known failure modes

### `session expired` when presenting

The OID4VP verification session expires after Credo's default window, and Heka's API does not
expose `expirationInSeconds` to lengthen it. A slow scan fails.

Present promptly. On an emulator, deliver the request by deep link rather than camera:

```bash
adb shell am start -a android.intent.action.VIEW -d '<openid4vp://…>' com.heka.wallet
```

The same works for the credential offer `yarn seed` prints. Keep the **single quotes**: `adb shell`
runs the command through a shell on the device, and an unquoted `&` truncates the URI. The wallet
then reports `Missing required 'redirect_uri' or 'response_uri'`, which looks like a malformed
request rather than a quoting mistake.

### `no presentation was received in time`

The agent's own timeout (default 180s, `AGENT_AUTH_TIMEOUT_MS`). Distinct from the above: this is
the agent giving up, not the session dying. Both usually mean the same thing — the presentation
took too long.

### `no such table: profiles` or `no such table: items`

Both mean the Askar store is not where the code thinks it is, for two different reasons.

`profiles` is the _concurrent_ form: an in-memory SQLite store opened with a pool larger than one
connection, where the connection that provisions the schema is not the one that reads it.

`items` is the same root cause on the time axis, and it is the one that bites during a demo: with
`inMemory: true` the database lives _inside_ the pooled connection, so when the pool retires that
connection the replacement opens an empty one. Measured at roughly twenty minutes of idling. It
surfaces as `NO_ATTESTATION` on every entry, with DID resolution as the visible failure — so it
reads as a Hedera or network problem.

Both are avoided by `ephemeralSqliteStore()` in `src/shared/askar-store.ts`, which uses a file in a
per-process temp directory. If either reappears, something has gone back to `inMemory`:

```bash
grep -rn "inMemory" src/
```

### `ERR_PACKAGE_PATH_NOT_EXPORTED` for `@verifiables/request-converter`

Credo 0.7 pulls in an ESM-only package whose exports map has no `default` condition, which the
CJS resolver tsx uses cannot follow. `scripts/patch-esm-exports.mjs` runs on postinstall and adds
it. If it fails, nothing in the repo starts.

### A2A client cannot reach the agent

The A2A client connects to the URL **in the agent card**, not the URL it was given. Under Docker
that must be the container's address:

```
ACME_AGENT_PUBLIC_URL=http://trustlens-agent:10003/
```

### Heka container exits with `EAI_AGAIN … postgres`

Its compose network is confused; `docker compose down && up -d` on the Identity Service fixes it.

⚠️ **`docker compose down` wipes Heka's database** — its dev compose gives Postgres no named
volume. Everything the seed created (issuer, DIDs, status list) disappears while
`.seed-state.json` still references it, and issuance then fails with `server_error`. After a
`down`, run `yarn seed --reset`.

### Port 3000 answers, but not with Heka

The registry stack maps Grafana to `127.0.0.1:3000`, the same port as the Identity Service.
Symptom: `/health` returns `302` and the seed talks to the wrong service entirely. Stop Grafana,
or do not run both stacks at once.

### Wallet shows a 16 KB compatibility dialog

Harmless — the native libraries are not 16 KB aligned, so Android runs the app in compatibility
mode. Dismiss it (`Don't Show Again`). It appears on every launch otherwise.

## Resource budget

The full picture — Heka, the demo services, an Android emulator and the registry stack — does not
fit on a 16 GB machine. Rough figures observed:

|                                                                  | RAM           |
| ---------------------------------------------------------------- | ------------- |
| Emulator (Pixel_7, 2–3 GB allocation)                            | 3–4 GB        |
| Registry stack (Mongo, Keycloak, OpenBao, registry, auth-server) | ~1.5–2 GB     |
| Heka Identity Service                                            | ~1 GB         |
| Demo services (six containers)                                   | ~600 MB total |

Run what the current step needs. The registry is not required for anything except its own
integration; the emulator is not required if the simulated holder is acceptable.

## Verifying without the UI

```bash
yarn test          # unit tests — one case per verdict
yarn verify:live   # the engine against the running publishers; prints verdicts
yarn derisk        # issue → status-bound → revoke → observe, against live Heka
yarn derisk:holder # proves signed credential bytes can be captured
yarn seed --check  # is the seed state complete
```

`yarn verify:live` is the fastest end-to-end confidence check: it exercises did:hedera
resolution, SD-JWT verification, digest binding and status lists in one run.

## Resetting

```bash
yarn seed --reset   # new DIDs, new credentials, regenerated catalogs (a few minutes — Hedera writes)
yarn seed           # idempotent: keeps DIDs, re-issues credentials and rewrites catalogs
```

Re-seeding is also how you recover after Heka's database has been wiped. Note that `--reset`
invalidates any credential already loaded into a wallet: re-issue it with a fresh offer.
