# T4 — A2A server: a separate page ("Acme Invoice Agent — server view")

> Status: done (2026-09-28) · Branch: `task/04-agent-server-view` from `task/03-presentation-ux`
> (fourth in the chain; T3 must meet its DoD first) · Builds on: T1 (`PresentedCredential`,
> `StatusCheck`), T2 phase 1 (`ui.js`), T3 phase 2 (what the agent records) — all already in this
> branch · Next in the chain: `task/05-mcp-llm-chat` branches from this one

## Why

The demo has a page for the orchestrator (Trust Lens) and one for the issuer (TrustCo Console),
and nothing for the third party in the story: the agent that pauses, asks, verifies and decides.
Everything it does is visible only as `console.log` lines in one terminal. The task of adding a
separate page for the A2A server serves the following goals:

- the third party in the story has a page: the agent's own view of tasks, authorizations,
  verified presentations and denials
- the relying party's record is separate from the Trust Lens audit and readable without a terminal
- the correctness fixes the page depends on land with it: the SDK task id, session filtering,
  `/health`
- an authorized context can be made to ask again, so a revocation can be shown biting a context
  that was authorized before it

## Findings

- `src/agent/index.ts` exposes only what `A2AExpressApp.setupRoutes` adds: `POST /` (JSON-RPC)
  and `GET /.well-known/agent-card.json`. No `/health`, no static files, no state endpoint.
  `GET /` is free.
- State lives in private fields (`authorizedContexts`, `sessionToContext` — written, never read —,
  `verifiedSessions`, `cancelled`, `verifierDid`, lines 120-125) and in an `InMemoryTaskStore`
  created inline (line 353) that cannot list tasks.
- The task id is `context.task?.id ?? randomUUID()` (line 175) instead of the SDK's
  `context.taskId`; the SDK keys its event bus by its own id, so `tasks/cancel` can miss.
- The agent and the AS share one Heka tenant (`prepare-wallet` returns the same did:key), so the
  agent's WebSocket receives the AS's sessions too and `verifiedSessions` grows with them
  (`onNotification`, lines 154-167, no filtering).
- Two agent cards exist: the live `agentCard()` (lines 77-115) and the digest-pinned static one
  written by `yarn seed` (`static/acme-site/.well-known/agent-card.json`). They differ in
  description, tags, examples and `url`. The static one must never be edited by hand.
- Operator-relevant facts already in memory: verifier DID, `PUBLIC_URL`, `AUTHORIZATION_TIMEOUT_MS`,
  LLM on/off (`invoice-work.ts:56`), WebSocket health (open/error/close/reconnect), session state
  transitions, status-check results (T1), disclosed claims (T1/T3).
- The console (`src/console`) is the pattern for a page: own static dir, `/shared` for
  `app.css`, JSON API under `/api`, vanilla JS polling.
- Port 10003 is already published in every run recipe (`run-demo`, README Path B); adding a
  port means touching README (five places), OPERATIONS, ARCHITECTURE and two skills.

## Scope

1. A journal and a state view inside the agent process: typed events, task index,
   authorization records, channel health.
2. Read-only HTTP API and a static page served by the same process on port 10003.
3. Correctness fixes the page depends on: SDK task id, WebSocket session filtering, `/health`.
4. One action: **Forget authorizations** (clears cached context authorizations, for the
   revocation demo on a reused context).
5. Docs and skills.

### Non-goals

- Holder or client actions (Send to wallet, Simulate, engaging) — those stay in the Trust Lens.
- Persisting anything; a second port; SSE or WebSockets to the browser.
- Changing the static agent card or the seed.

## Decisions (design review)

1. The page is the **server's** view, read-only except Forget authorizations (Q14, Q16).
2. Same process, same port: `GET /` and `GET /api/*` on 10003; no new env var (Q15).
3. Polling every 2 s, like the rest of the repo (Q16).
4. Title: "Acme Invoice Agent — server view" (Q16). Sections per Q28.

## Plan

### Phase 1 — journal and state (`src/agent/journal.ts`, `src/agent/state.ts`)

```ts
// journal.ts — ring buffer, newest first on read
export type AgentEventType =
  | 'task.state'
  | 'auth.requested'
  | 'session.state'
  | 'auth.verified'
  | 'status.checked'
  | 'auth.authorized'
  | 'auth.denied'
  | 'channel.open'
  | 'channel.closed'
  | 'llm.fallback'
  | 'authorizations.cleared'
export interface AgentEvent {
  id: string
  at: string
  type: AgentEventType
  taskId?: string
  contextId?: string
  sessionId?: string
  text: string
  data?: unknown
}
export class AgentJournal {
  constructor(capacity = 500)
  record(event: Omit<AgentEvent, 'id' | 'at'>): AgentEvent
  list(options?: { since?: string; limit?: number }): AgentEvent[]
}

// state.ts — what the page reads
export interface TaskView {
  id: string
  contextId: string
  state: string
  startedAt: string
  updatedAt: string
  steps: Array<{ at: string; state: string; text?: string }>
  sessionId?: string
  result?: string
  error?: string
}
export interface AuthorizationRecord {
  sessionId: string
  taskId: string
  contextId: string
  requestedAt: string
  sessionState: string
  expiresAt: string
  verifiedAt?: string
  presentation?: Omit<PresentedCredential, 'vpToken'> // T1 type; the token itself stays with the Trust Lens audit
  status?: StatusCheck
  outcome?: 'authorized' | 'denied'
  reason?: string
  decidedAt?: string
}
export interface ChannelView {
  state: 'connecting' | 'open' | 'closed'
  since: string
  reconnects: number
  lastError?: string
}
export class AgentState {
  readonly journal: AgentJournal
  readonly tasks: Map<string, TaskView>
  readonly authorizations: Map<string, AuthorizationRecord>
  channel: ChannelView
  taskStep(taskId, contextId, state, text?): void // called from say()
  authorizationRequested(record): void
  sessionState(sessionId, state): void
  authorizationDecided(sessionId, outcome, details): void
  forgetAuthorizations(): number // returns how many contexts were cleared
}
```

Wiring in `src/agent/index.ts`: `say()` calls `state.taskStep`; `requestAuthorization` records
`auth.requested` with `expiresAt`; `onNotification` records `session.state` **only for sessions
in `sessionToContext`** (everything else is the AS on the shared tenant and is dropped);
T1's status check records `status.checked` with `{ statusListCredential, statusListIndex, revoked }`;
success/denial record `auth.authorized` / `auth.denied`; `connectNotifications` records
`channel.open` / `channel.closed` and keeps `reconnects`; `prepareInvoiceReport` gets an
`onFallback(reason)` callback that records `llm.fallback`.

Fix: `const taskId = context.taskId` (the SDK sets it; equals `context.task.id` when a task is
continued). Keep `contextId` as is.

### Phase 2 — API and page (`src/agent/index.ts`, `src/agent/public/`)

Mounted **before** `setupRoutes` on the same `express()`:

| Route                             | Returns                                                                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                     | `{ ok: true, uptimeSeconds, verifierDid, channel: ChannelView }`                                                                                                                                                          |
| `GET /api/state`                  | `{ agent: { name, publicUrl, port, verifierDid, resourceDid, authorizationTimeoutMs, llm: { enabled, model? } }, trust: { trustedIssuer, statusListOrigin }, channel, counts: { tasks, authorized, denied }, startedAt }` |
| `GET /api/card`                   | `{ live: agentCard(), staticCardUrl: 'https://acme-invoices.example/.well-known/agent-card.json', note }`                                                                                                                 |
| `GET /api/tasks`                  | `{ tasks: TaskView[] }` newest first                                                                                                                                                                                      |
| `GET /api/tasks/:id`              | `TaskView` or 404                                                                                                                                                                                                         |
| `GET /api/authorizations`         | `{ authorizations: AuthorizationRecord[] }` newest first                                                                                                                                                                  |
| `GET /api/events?since=&limit=`   | `{ events: AgentEvent[] }`                                                                                                                                                                                                |
| `POST /api/authorizations/forget` | `{ cleared: n }`; records `authorizations.cleared`                                                                                                                                                                        |
| `GET /` and static                | `src/agent/public/{index.html, agent.js}`; `/shared` → `src/web/public` (for `app.css`, `ui.js`)                                                                                                                          |

`resourceDid` is `loadState().dids.acmeAgent`; `trustedIssuer` is `loadState().issuerDid`.
`POST /` keeps going to the A2A router (static serving only answers `GET`).

Page (`index.html`, `agent.js`, vanilla, `ui.js` helpers, `app.css`):

- **Header:** `Acme Invoice Agent <span class="role-chip">Server</span>`, subtitle "The agent's
  own view: what it was asked, what it verified, what it refused", a channel badge
  (`Heka notifications: open | reconnecting…`), nav tabs Overview · Tasks · Authorizations · Events.
- **Overview:** `.panel` Identity (verifier did:key, resource did:hedera, public URL, timeout,
  LLM on/off with model) · `.panel` Agent card (live JSON in `<pre>`, and the note "the
  digest-pinned card is served by the publisher site; this is the live one clients connect to")
  · counters.
- **Tasks:** `.cards` — id (short), context, state badge, started, steps as `.timeline`,
  result/error.
- **Authorizations:** `.cards` — session (short) → task, `.steps` strip from `sessionState`
  (Requested → Wallet fetched → Verified → Status checked → Authorized/Denied), `expiresAt`
  countdown while pending, then claims (`role · org`), issuer, holder, status check row, or the
  denial reason in red. A `button.danger` **Forget authorizations** with the inline confirmation
  "Clears N authorized contexts; the next task in those contexts will ask again".
- **Events:** `.timeline` newest first, filter chips by type, `since` polling.
- All views poll every 2 s while visible; Overview also refreshes the channel badge.

### Phase 3 — docs and skills

- `README.md`: "Open the demo" adds `http://localhost:10003/` (agent server view); the components
  table row for the agent; Path A/B notes that the page rides on the agent's port.
- `docs/OPERATIONS.md` port table: `10003 (A2A + server view)`.
- `docs/ARCHITECTURE.md`: component diagram note, layout (`src/agent/{journal,state}.ts`, `src/agent/public`).
- `.claude/skills/run-demo/SKILL.md` "Confirm it is actually up" adds
  `curl -s http://localhost:10003/health`; `.claude/skills/troubleshoot/SKILL.md` points at
  `/health` and the Events tab for "did the wallet fetch the request".

## Definition of Done

- [ ] `GET http://localhost:10003/` serves the page; `/health`, `/api/state`, `/api/card`,
      `/api/tasks`, `/api/authorizations`, `/api/events`, `POST /api/authorizations/forget` exist
      with the shapes above; `POST /` and the agent card behave exactly as before.
- [ ] The agent uses `context.taskId`; `tasks/cancel` on the id the client sees marks the task
      cancelled (visible in the Tasks tab).
- [ ] `onNotification` records nothing for sessions the agent did not create.
- [ ] Every task step, authorization request, session state, status check, decision, channel
      change and LLM fallback appears in `/api/events` with the right ids.
- [ ] The page shows identity, both cards' relationship, tasks, authorizations with presentation
      details and denials, and events; it polls every 2 s.
- [ ] Forget authorizations clears `authorizedContexts` (and prunes the decided sessions' state)
      and is journaled.
- [ ] Global DoD (README); docs and both skills updated.

## Steps to validate

Stack per `run-demo` on this branch (it already contains T1–T3).

1. **Health and identity**

   ```bash
   curl -s http://localhost:10003/health
   ```

   Expect `{"ok":true,"uptimeSeconds":…,"verifierDid":"did:key:…","channel":{"state":"open",…}}`.

   ```bash
   curl -s http://localhost:10003/api/state | jq '.agent, .trust, .counts'
   ```

   Expect `resourceDid` equal to `dids.acmeAgent` in `.seed-state.json`, `trustedIssuer` equal to
   `issuerDid`, `llm.enabled` matching whether `OPENAI_API_KEY` is set.

2. **A2A untouched**

   ```bash
   curl -s http://localhost:10003/.well-known/agent-card.json | jq .name
   ```

   Expect `"Acme Invoice Agent"`. Then `yarn verify:live` → `RESULT: PASS`.

3. **A task appears as it happens** — open `http://localhost:10003/`, Tasks tab. In the Trust
   Lens, engage _Acme Invoice Agent_. Within 2 s a task card appears with steps
   `submitted → working → working → auth-required`; the Authorizations tab shows a session
   `Requested` with a countdown; `curl -s http://localhost:10003/api/tasks | jq '.tasks[0] | {id, contextId, state}'`
   matches `a2a.taskId`/`a2a.contextId` from `GET :4000/api/task/<id>` (T3).

4. **The authorization is decided on the page** — simulate the presentation in the Trust Lens.
   The authorization card moves through _Verified → Status checked → Authorized_ and shows
   `role · org`, the issuer DID, the holder `did:key`, and `index 3 · live`. Events tab lists
   `auth.verified`, `status.checked`, `auth.authorized` with the same `sessionId`.

5. **A denial is recorded** — revoke the officer credential in the console, engage, simulate:
   the authorization card turns red with `the Finance Data Officer credential has been revoked by
its issuer`, the task card shows `failed`; `curl -s http://localhost:10003/api/events | jq '.events[0:3]'`
   starts with `auth.denied`. Restore.

6. **Only the agent's sessions** — in the Trust Lens MCP tab, invoke the sensitive tool and
   simulate (this creates an AS session on the shared tenant). The agent's Authorizations tab and
   Events tab gain nothing; the agent log no longer prints that session either.

7. **Forget authorizations** — take `contextId` from step 3's task. Send a second message in
   that context straight to the agent, non-blocking (a blocking `message/send` waits for a final
   state, and `auth-required` is deliberately not final — the Trust Lens stream must survive the
   pause):

   ```bash
   curl -s -X POST http://localhost:10003/ -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"configuration":{"blocking":false},"message":{"kind":"message","messageId":"m-reuse-1","role":"user","contextId":"<contextId>","parts":[{"kind":"text","text":"Reconcile May supplier invoices and prepare the payment export."}]}}}'
   ```

   Take `result.id` and, after a few seconds, `tasks/get`:

   ```bash
   curl -s -X POST http://localhost:10003/ -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":2,"method":"tasks/get","params":{"id":"<result.id>"}}' | jq '.result.status.state'
   ```

   Expect `"completed"` with no `auth-required` step on the Tasks tab (the context is still
   authorized). Press **Forget authorizations** on the page (`cleared: 1` in the response, an
   `authorizations.cleared` event). Repeat both curls with `messageId` `m-reuse-2`: `tasks/get` says
   `"auth-required"` and a new authorization card appears.

8. **Channel health** — restart the Identity Service container (restart, never `down`):

   ```bash
   docker restart heka-identity-service-heka-identity-service-1
   ```

   The header badge shows `reconnecting…` then `open`; `/api/state` shows `channel.reconnects`
   incremented; Events has `channel.closed` then `channel.open`.

9. **Cancel hits the right task** — engage, and while in `auth-required`:

   ```bash
   curl -s -X POST http://localhost:10003/ -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":2,"method":"tasks/cancel","params":{"id":"<a2a taskId>"}}'
   ```

   Expect the Tasks tab to show the task `canceled` and no further steps after the presentation.

## Docs to update

`README.md` (Open the demo, components table, Path A/B notes), `docs/OPERATIONS.md`,
`docs/ARCHITECTURE.md`, `.claude/skills/run-demo/SKILL.md`, `.claude/skills/troubleshoot/SKILL.md`.

## Risks and open questions

- Serving static files on the A2A port means the A2A router's global `express.json()` also runs
  for page requests; harmless, but the static handler must be mounted first so `GET /` is the
  page and `POST /` is the protocol.
- `verifiedSessions` filtering changes a behaviour the AS never relied on, but confirm with
  `yarn as` running that MCP step-ups still complete (step 6).
- Step 7 depends on the client-chosen `contextId` semantics of the A2A SDK 0.3.14
  (`incomingMessage.contextId || task?.contextId || uuidv4()`); if the SDK version moves, re-check.
