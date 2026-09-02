# Technical debt — `demo/a2a-oid4vp`

Findings from taking this demo through a full end-to-end run on a clean Windows 11 host
(August 2026): Heka Identity Service in Docker, the demo in a Node 22 container, the real Heka
Wallet on an Android emulator, and a live OID4VP presentation resolving an A2A task.

The demo *does* work — the flow it advertises is real and it completed. Everything below is what
stood between "clone the repo" and that first completed task, plus what would stop the next person
from having to repeat the archaeology. Getting to a first successful run took roughly two working
days, and almost none of that was the protocol.

Every item was hit for real. Where a fix has been written and validated, it is marked
**[validated]**; those changes exist in a working tree and are not yet committed.

## Summary

| # | Item | Impact | Effort |
|---|---|---|---|
| [TD-1](#td-1--dependency-versions-drift-from-heka-wallet) | Dependency drift from Heka Wallet | Blocker — silent | S |
| [TD-2](#td-2--askar-in-memory-store-races-against-its-own-pool) | Askar in-memory pool race | Blocker — intermittent | XS |
| [TD-3](#td-3--the-authorization-timeout-is-shorter-than-a-human) | 30 s authorization timeout | Blocker | XS |
| [TD-4](#td-4--the-timeout-reason-never-reaches-the-user) | Rejection reason discarded | High — diagnostic | XS |
| [TD-5](#td-5--the-wait-leaks-a-listener-and-a-timer-per-task) | Listener/timer leak per task | Medium | S |
| [TD-6](#td-6--the-agent-card-hardcodes-localhost) | Agent card hardcodes `localhost` | Blocker off-loopback | XS |
| [TD-7](#td-7--revocation-is-never-checked) | Revocation not checked | High — security | M |
| [TD-8](#td-8--the-flow-cannot-be-run-unattended) | No non-interactive mode | High — no CI | S |
| [TD-9](#td-9--the-boundaries-are-silent) | No observability at boundaries | High — diagnostic | S |
| [TD-10](#td-10--the-readme-assumes-a-posix-host-with-a-c-toolchain) | README assumes POSIX + toolchain | High — onboarding | M |
| [TD-11](#td-11--the-verification-session-expires-before-the-agent-gives-up) | Session expires before agent times out | High | S |
| [TD-12](#td-12--heka-wallet-cannot-create-the-example-credential) | Wallet example credential crashes | Blocker (upstream) | XS |

S ≈ under an hour · M ≈ half a day.

---

## TD-1 — Dependency versions drift from Heka Wallet

**Symptom.** The wallet receives the DIDComm invitation, the person taps Accept, and nothing
reaches the agent. No error on either side. Separately, `yarn install` fails on Windows with a
`node-gyp` build error.

**Cause.** Dependencies are declared with caret ranges — `@credo-ts/* ^0.6.2`,
`@openwallet-foundation/askar-* ^0.4.3` — while Heka Wallet is on Credo 0.7.x. Two consequences:

- The demo's Credo agent and the wallet's agent no longer agree on DIDComm message handling, so
  delivery fails *quietly*. Nothing in either log says "version mismatch"; the message simply
  never arrives, which reads as a network or pairing problem and sends you looking in the wrong
  place.
- askar `0.4.3` binds native code through `@2060.io/ffi-napi`, which compiles at install time.
  askar `0.6.0` uses `koffi` with prebuilt binaries. On a Windows host without MSVC, `0.4.3`
  cannot install at all — and the caret range does not float far enough to reach `0.6.0`.

The two components live in the same repository. Their identity stacks silently disagreeing is a
repository-level defect, not a user error.

**Fix. [validated]** Pin exact versions matched to the wallet — `@credo-ts/* 0.7.0`,
`@openwallet-foundation/askar-* 0.6.0` — and say in a comment *why* they are pinned rather than
ranged. Credo 0.7 pulls in `@verifiables/request-converter`, whose `exports` map is ESM-only with
no `default` condition, so `tsx` resolution fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`; a
postinstall patch adds the missing condition. (This belongs upstream in that package; the patch is
a stopgap.)

Better still, hoist the Credo version to a single place shared with `heka-wallet` so the two
cannot drift again.

**Payoff.** The demo works against the current wallet instead of a wallet from months ago. It
installs on Windows without a C toolchain. And the worst failure mode here — *silent* non-delivery
— stops being reachable by accident.

---

## TD-2 — Askar in-memory store races against its own pool

**Symptom.** Intermittent on startup:

```
Error occurred during transaction, rollback
no such table: profiles
```

Sometimes the agent starts fine. Sometimes it does not. Same code, same command.

**Cause.** `credo-helpers.ts` configures the Askar store as `{ type: 'sqlite', config: { inMemory: true } }`
and leaves the connection pool at its default size. An in-memory SQLite database is *per
connection*: two connections are two unrelated databases. Whichever connection provisions the
profile schema is not necessarily the one that later reads it, so the outcome depends on pool
scheduling.

Intermittency is what makes this expensive. It reads as data corruption, and the natural response
— wipe and retry — appears to work about half the time, which teaches exactly the wrong lesson.

**Fix. [validated]** Pin the pool to a single shared connection, with the reason in a comment:

```ts
config: { inMemory: true, maxConnections: 1, minConnections: 1 }
```

**Payoff.** A nondeterministic startup failure becomes impossible. Anyone reading the config now
learns the constraint instead of rediscovering it.

### The same bug on the time axis — `no such table: items`

Pinning the pool fixes the *concurrent* form and leaves a second one, found later in
`demo/trust-lens`: a pool of one connection is not one connection *forever*. Credo turns the
config into `sqlite://:memory:?max_connections=1&min_connections=1`, the pool retires that
connection on its idle timer, and the replacement opens a brand-new empty database. Everything
provisioned at startup is gone.

Measured at roughly twenty minutes of idling — the gap between setting a demo stand up and showing
it to someone. It presents as `no such table: items` during DID resolution, which reads as a
network or ledger problem rather than as local storage that quietly emptied itself.

**Fix.** A file in a per-process temp directory: just as disposable, and it survives reconnection.
See `demo/trust-lens/src/shared/askar-store.ts` for the version that was validated by leaving a
stand idle for 25 minutes and re-running verification.

**Payoff.** The demo still works after a coffee break. Without it, the first thing anyone sees
after any pause is a failure with a misleading cause.

---

## TD-3 — The authorization timeout is shorter than a human

**Symptom.** `Authorization timeout exceeded.` The wallet notification arrives, and by the time
the person has looked at it the task has already failed.

**Cause.** `waitForContextAuthorization(contextId, timeoutMs = 30000)`. Thirty seconds must cover:
the status update reaching the CLI, DIDComm delivery to the device, the person noticing, unlocking
the wallet with a PIN, reading the requested claims, and tapping Share. On an emulator, or on a
phone that has to be picked up, unlocking alone can spend most of that budget.

The number is not merely tight — it is in tension with the point of the demo. This flow exists to
put a human in the loop; a timeout that assumes the human is already staring at an unlocked device
contradicts it.

**Fix. [validated]** Raise the default to 180 s and make it configurable
(`DEMO_AGENT_AUTH_TIMEOUT_MS`). Fix TD-11 at the same time, or the Identity Service session will
expire first and the longer agent timeout will buy nothing.

**Payoff.** The flow completes for a person operating at human speed, which is the only speed the
demo is about.

---

## TD-4 — The timeout reason never reaches the user

**Symptom.** A failed task whose message is `Agent error: Unknown error occurred`.

**Cause.**

```ts
setTimeout(() => reject('Authorization timeout exceeded.'), timeoutMs)
```

The promise is rejected with a **string**. The handler downstream does
`error instanceof Error ? error.message : 'Unknown error occurred'` — so the one sentence that
explains the failure is thrown away precisely when it is needed.

**Fix.** `reject(new Error('Authorization timeout exceeded'))`. Audit the other rejection paths for
the same pattern.

**Payoff.** The commonest failure in the demo starts naming itself. One line of code removes an
entire branch of blind debugging — a person who sees "Authorization timeout" checks the wallet; a
person who sees "Unknown error occurred" checks everything.

---

## TD-5 — The wait leaks a listener and a timer per task

**Symptom.** Not observed in a single-task run; visible under repeated use as
`MaxListenersExceededWarning`, and as memory that never comes back.

**Cause.** `waitForContextAuthorization` registers `notificationWebSocket.on('message', …)` on
every call and never removes it, and never clears its `setTimeout`. Both outlive the task. After
*n* authorizations, every incoming notification is parsed *n* times by handlers whose promises are
long settled.

**Fix.** Use `once`/`off` around a named handler, `clearTimeout` in a `finally`, and remove the
handler on both resolve and reject. Cleaning up the `verificationSessionContextMap` entry at the
same time closes the matching leak in that map.

**Payoff.** The agent stops accumulating state per task. This is the difference between a demo
that survives a live session and one that has to be restarted between takes.

---

## TD-6 — The agent card hardcodes `localhost`

**Symptom.** `fetch failed` when the client engages the agent — even though the agent is up and its
card is reachable at the URL the client was configured with.

**Cause.**

```ts
url: `http://localhost:${DEMO_AGENT_PORT}/`,
```

An A2A client fetches the card, then connects to the URL **inside** the card, not the one it was
handed. So the card's `url` is not documentation — it is the actual endpoint, and it is fixed to
the client's own loopback. The moment the agent is anywhere else — a container, another host, a
LAN address a phone can reach — the client is sent to itself.

This is worth calling out because it is the exact configuration the rest of the setup pushes you
toward: a Windows host needs the demo in a container (TD-10), and a container is precisely where
`localhost` stops meaning the agent.

**Fix.** `DEMO_AGENT_PUBLIC_URL`, defaulting to the current value, and document that it must be
the address *the client* can reach.

**Payoff.** The demo becomes deployable off the loopback — Docker, a second machine, a real
device — without a source edit.

---

## TD-7 — Revocation is never checked

**Symptom.** None. That is the problem. A credential revoked by its issuer still authorizes the
task.

**Cause.** The agent proceeds on the `ResponseVerified` notification from the Identity Service.
That state means the presentation is cryptographically sound, holder-bound, and satisfies the
presentation definition — all true of a revoked credential. Heka's verifier does not evaluate
credential status, so nothing in this path ever asks whether the credential is still good.

**Fix.** After `ResponseVerified`, and before granting, resolve the credential's status list and
check the bit. Fail closed: an unreachable or unreadable status list is a denial, not a pass. If
the presented credential carries no status information, decide deliberately and state the decision
in the README rather than leaving it implied.

**Payoff.** The demo's authorization step becomes an authorization step. Without this, "present a
credential to unlock the task" is a signature check, and the issuer's ability to revoke — one of
the strongest arguments for verifiable credentials over bearer tokens — is not demonstrated. It
also makes the relying-party responsibility explicit for anyone copying this code: *the verifier
did not check status for you.*

---

## TD-8 — The flow cannot be run unattended

**Symptom.** Every end-to-end run needs a person at a keyboard. There is no smoke test, so TD-1
went unnoticed until someone ran the demo by hand.

**Cause.** `confirmAction` blocks on `readline` with no bypass. The wallet tap genuinely requires a
human; the CLI's own confirmations do not.

**Fix. [validated]** `AUTO_CONFIRM=1` skips CLI confirmations while logging what was
auto-confirmed. Beyond that, a scripted mode (fixed message, exit code on task state) turns the
happy path into something CI can assert — and pairing it with a stub holder would cover everything
except the tap.

Keep the boundary intact: automate the CLI's own prompts, never the wallet's Accept/Share. That
tap is the demonstration.

**Payoff.** Regressions like TD-1 get caught by a pipeline in seconds instead of by a person over
two days. Bug reports become reproducible commands.

---

## TD-9 — The boundaries are silent

**Symptom.** The person taps Share in the wallet and the agent does nothing. There is no way to
tell *which* link broke.

**Cause.** The flow crosses four boundaries — wallet → Identity Service, verification inside the
service, service → agent over WebSocket, and the agent's own session→context lookup — and only the
last has any logging. The notification socket reports neither open, nor error, nor close, nor
arriving events, and the verification session id is never printed, so it cannot be matched against
the service's own logs.

**Fix. [validated]** Log at the boundaries with structured markers — `[WS]` for socket lifecycle
and every received event's type/state/id, `[AUTH]` for session creation with its id and context.
Gate Credo's own debug level behind `CREDO_LOG_DEBUG=1` instead of requiring a source edit. This
is what made the failure legible in practice.

**Payoff.** Minutes instead of a day. It also changes what a bug report can contain: a log naming
the session id and the last state it reached, rather than "it doesn't work".

---

## TD-10 — The README assumes a POSIX host with a C toolchain

**Symptom.** A Windows user does not reach step 5. Each of the following was hit in order:

| Step | What happens |
|---|---|
| `cmd1 && cmd2` | PowerShell 5.1 rejects `&&` |
| `corepack enable` | `EPERM … open 'C:\Program Files\nodejs\pnpx.CMD'` without an elevated shell |
| `yarn install` | native askar fails to build — no MSVC (see TD-1) |
| `adb devices` | not on `PATH`; Android Studio does not add it |
| `yarn run:android` | `JAVA_HOME` unset; Android Studio's bundled JBR is too new — Gradle: `Unsupported class file major version 69`. JDK 17 required |
| RN native build | Windows path limit → `ninja: error: manifest 'build.ninja' still dirty`. Needs a short checkout path; a junction does not help, React Native resolves it back to the real path |

None of this is exotic — it is one mainstream desktop OS.

**Fix.** A "Running on Windows" section covering: PowerShell-safe commands (no `&&`), running the
demo in a `node:22-bookworm` container with a volume for `node_modules`, the JDK 17 requirement
with its exact error text, `adb` on `PATH`, and the short-path constraint. The container recipe
already exists as `docker-compose.demo.yml` and only needs committing. Naming the errors verbatim
matters — that is what people search for.

**Payoff.** Removes the single largest cost measured in this run. A demo exists to be run by
people who have not read its source; a two-day setup means most will not get to the interesting
part.

---

## TD-11 — The verification session expires before the agent gives up

**Symptom.** The wallet is open, the person taps Share, and the wallet reports:

```
{"error":"invalid_request","error_description":"session expired"}
```

**Cause.** Two independent clocks, neither aligned with the other. The agent waits (TD-3), but the
Identity Service's verification session has its own lifetime — Credo's default — and
`POST /openid4vc/verification-session/request` exposes no way to set it. Raising the agent's
timeout therefore does nothing: it waits patiently on a session that is already dead.

The operational workaround is to create the request and deliver it in one step and present
immediately, which is fine for a rehearsed demo and hostile to a first-time user.

**Fix.** Expose `expirationInSeconds` (or equivalent) on the verification-session endpoint in Heka
Identity Service, and have the demo set it explicitly alongside its own timeout so the two are
visibly derived from one number. Until then, state the constraint in the README — an undocumented
short window is worse than a short window.

**Payoff.** TD-3's fix actually takes effect, and the demo tolerates a person who reads the
consent screen before approving it.

---

## TD-12 — Heka Wallet cannot create the example credential

**Symptom.** During wallet onboarding, with `ENABLE_EXAMPLE_CREDENTIAL=true`:

```
Failed to create holder DID for example credential
Error: 1045
```

The wallet never obtains a credential, so there is nothing to present and the demo cannot proceed.

**Cause.** `heka-wallet/app/src/utils/agent.ts:290`:

```ts
const holderPublicKey = await agent.kms.createKey({ … })
const holderDidCreateResult = await agent.dids.create({
  method: 'key',
  options: { keyId: holderPublicKey },   // object passed where an id string is expected
})
```

`createKey` returns a key record; `keyId` wants `holderPublicKey.keyId`. Askar receives an object
and fails with a numeric error code that names nothing.

**Fix. [validated]** `options: { keyId: holderPublicKey.keyId }`.

**Payoff.** The documented setup path works. This one line is a hard blocker on the demo's critical
path: README step 3 instructs the user to enable exactly this flag, so the first thing the
instructions tell you to do is the thing that fails.

**Note.** The defect is in `heka-wallet`, not in this demo — but this demo depends on it, so the
fix belongs upstream in the wallet and the demo README should name the dependency.

---

## Adjacent: Identity Service dev compose destroys its own data

Not part of this demo, but it will be hit by anyone running it.

The Identity Service dev compose gives Postgres no named volume, so a routine `docker compose down`
destroys the issuer, DIDs and any status lists — while every artifact that references them (seed
state, credentials already in a wallet, DIDs published to Hedera) survives and now points at
nothing. The result is a spread of confusing downstream errors (`server_error` on issuance,
issuer-not-found, DIDs that no longer resolve) whose common cause is several steps upstream and
invisible.

**Fix.** Add a named volume. It costs one line and converts an accidental data loss into an
explicit one (`down -v`).

---

## Suggested order

1. **TD-12, TD-1, TD-2, TD-3, TD-6** — the blockers. Without these a clean checkout does not reach
   a completed task. All are small; four are one-liners.
2. **TD-4, TD-9** — make failures legible before anything else. Cheap, and they pay for themselves
   on the next investigation.
3. **TD-11, TD-10** — make the flow survive a real human and a real Windows host.
4. **TD-8** — lock in the above with an unattended run, so it cannot silently regress.
5. **TD-7, TD-5** — correctness and hygiene. TD-7 is the one that changes what the demo *argues*,
   not just whether it runs.
