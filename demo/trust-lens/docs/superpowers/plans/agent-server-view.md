# T4 — Agent server view Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the A2A server its own page — "Acme Invoice Agent — server view" — on the agent's existing port: a journal and a state index inside the process, a read-only JSON API, a polling page, one action (Forget authorizations), and the three correctness fixes the page depends on (SDK task id, one journaled entry point for session states, `/health`).

**Architecture:** Two new modules inside the agent process — `src/agent/journal.ts` (a typed ring buffer) and `src/agent/state.ts` (task index, authorization records, channel health, the authorized-context cache) — are fed by the executor in `src/agent/index.ts` at the points where it already logs. `src/agent/server-view.ts` mounts static files and `/health` + `/api/*` on the same `express()` **before** `A2AExpressApp.setupRoutes`, so `GET /` is the page and `POST /` stays the protocol. The page (`src/agent/public/`) is vanilla JS on `ui.js` / `app.css` served through `/shared`, polling every 2 s, like the console.

**Tech Stack:** TypeScript (`tsx`), Express 5, `@a2a-js/sdk` 0.3.14, `ws`, vitest 3, vanilla browser JS/CSS (no build step).

**Brief:** `docs/tasks/04-agent-server-view.md` is the source of truth for scope, DoD and validation. Decisions from the grilling round of 2026-09-28 that refine it against the code on `task/03-presentation-ux`:

1. `tasks/cancel`: the SDK calls `cancelTask(id, bus)` and then waits for a **final event on that bus**, so `cancelTask` publishes `canceled` itself; the wait loop checks the flag on every tick and stops silently. The Heka session is left to expire.
2. Forget authorizations clears `authorizedContexts` and prunes `sessionStates` / `sessionToContext` **only for decided sessions** (a pending authorization keeps polling its state). `cleared` is the number of contexts.
3. The brief's validation step 7 uses a blocking `message/send`; the SDK's blocking send waits for `final: true`, and `auth-required` is not final (it must not be — the Trust Lens stream would end at the pause). The step is rewritten with `"configuration": { "blocking": false }` plus `tasks/get`.
4. On a denial the record carries issuer / holder / type / status but **no claims** — the same rule `deniedResult` applies for the client. `vpToken` never reaches the page.
5. `AgentJournal` is its own class (typed `AgentEventType`, ring buffer of 500, `since`), not `AuditLog`.
6. Live validation runs against a second agent on `ACME_AGENT_PORT=10004` and a second web on `4001`; the operator's stack on 10003 / 4000 is not touched. Validation step 8 (restart the Identity Service) needs the operator's explicit yes.

## Global Constraints

- English throughout — code, comments, docs, commit messages. Comments explain _why_.
- `src/core` stays dependency-light (Node built-ins only). Nothing in this plan touches `src/core`.
- Prettier: `printWidth: 120`, no semicolons, single quotes, `arrowParens: always`, trailing commas `es5`, LF. Run `yarn prettier --check <files>` on every file touched; `node --check` on every browser script.
- `yarn typecheck` and `yarn test` must pass after every task; never add `// @ts-expect-error`.
- The A2A protocol surface does not change: the same text parts, the same extension metadata (`authorizationRequest`, `authorizationStatus`, `authorizationResult`), the same agent card. `POST /` and `GET /.well-known/agent-card.json` behave exactly as before.
- The static agent card `static/acme-site/.well-known/agent-card.json` and the seed are not edited.
- No new port, no new env var, no persistence, no SSE / WebSocket to the browser.
- Invariant 6 — refusals are audited: every denial is journaled as `auth.denied` with its reason; a timeout is a denial (`no presentation was received in time`).
- Exact strings other code and docs key on (unchanged from T3): `The wallet fetched the request.`, `Presentation verified; checking the credential's status.`, `no presentation was received in time` (`NO_PRESENTATION_IN_TIME`).
- Page title: `Acme Invoice Agent — server view`; header `Acme Invoice Agent <span class="role-chip">Server</span>`; subtitle `The agent's own view: what it was asked, what it verified, what it refused`; tabs Overview · Tasks · Authorizations · Events; polling every 2 s while the tab is visible.
- Work from `demo/trust-lens`; commits on `task/04-agent-server-view`; commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; use `git -c core.safecrlf=false commit` if git complains about CRLF.
- The operator's services (web :4000, agent :10003, AS :4300, MCP :4400, console :4100, Heka :3000/:3003) are theirs: do not start, stop or restart them. Live validation uses a second agent/web pair on 10004 / 4001 (Task 8).

---

### Task 1: The journal — `src/agent/journal.ts`

**Files:**

- Create: `src/agent/journal.ts`
- Test: `src/agent/__tests__/journal.test.ts`

**Interfaces:**

- Produces: `type AgentEventType`, `interface AgentEvent { id; at; type; taskId?; contextId?; sessionId?; text; data? }`, `class AgentJournal { constructor(capacity = 500); record(event: Omit<AgentEvent, 'id' | 'at'>): AgentEvent; list(options?: { since?: string; limit?: number }): AgentEvent[]; get size(): number }`.

- [ ] **Step 1: Write the failing test**

Create `src/agent/__tests__/journal.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { AgentJournal } from '../journal'

describe('AgentJournal', () => {
  it('stamps an id and a time and lists newest first', () => {
    const journal = new AgentJournal()
    const first = journal.record({ type: 'channel.open', text: 'open' })
    const second = journal.record({ type: 'task.state', taskId: 't1', contextId: 'c1', text: 'submitted' })

    expect(first.id).toMatch(/[0-9a-f-]{36}/)
    expect(Date.parse(first.at)).not.toBeNaN()
    expect(journal.list().map((event) => event.id)).toEqual([second.id, first.id])
    expect(journal.list()[0]).toMatchObject({ type: 'task.state', taskId: 't1', contextId: 'c1' })
  })

  it('returns only what came after `since`, and everything when the id is unknown', () => {
    const journal = new AgentJournal()
    const a = journal.record({ type: 'task.state', text: 'a' })
    const b = journal.record({ type: 'task.state', text: 'b' })
    const c = journal.record({ type: 'task.state', text: 'c' })

    expect(journal.list({ since: a.id }).map((event) => event.text)).toEqual(['c', 'b'])
    expect(journal.list({ since: c.id })).toEqual([])
    expect(journal.list({ since: 'gone' }).map((event) => event.text)).toEqual(['c', 'b', 'a'])
    expect(journal.list({ limit: 2 }).map((event) => event.text)).toEqual(['c', 'b'])
    expect(journal.list({ since: a.id, limit: 1 }).map((event) => event.text)).toEqual(['c'])
    expect(b.text).toBe('b')
  })

  it('drops the oldest entries past its capacity', () => {
    const journal = new AgentJournal(3)
    for (const text of ['1', '2', '3', '4', '5']) journal.record({ type: 'task.state', text })

    expect(journal.size).toBe(3)
    expect(journal.list().map((event) => event.text)).toEqual(['5', '4', '3'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest run src/agent/__tests__/journal.test.ts`
Expected: FAIL — `Cannot find module '../journal'`.

- [ ] **Step 3: Write the journal**

Create `src/agent/journal.ts`:

```ts
/**
 * The agent's own journal: what it was asked, what it verified, what it refused.
 *
 * Distinct from the Trust Lens audit (src/core/audit.ts), which records the orchestrator's trust
 * decisions. This is the relying party's side of the same story — task steps, verifier-session
 * states, status checks, decisions and the health of the notification channel — kept in memory
 * for the server view and nothing else. A ring buffer, because a stand runs for hours and the
 * page only needs the recent past.
 */

import { randomUUID } from 'node:crypto'

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
  private readonly events: AgentEvent[] = []

  public constructor(private readonly capacity = 500) {}

  public record(event: Omit<AgentEvent, 'id' | 'at'>): AgentEvent {
    const recorded: AgentEvent = { id: randomUUID(), at: new Date().toISOString(), ...event }
    this.events.push(recorded)
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity)
    return recorded
  }

  /**
   * Newest first. `since` is an event id: only what was recorded after it comes back, which is
   * what a poller wants. An unknown id — evicted, or from before a restart — returns everything,
   * so a stale poller catches up instead of going quiet.
   */
  public list(options: { since?: string; limit?: number } = {}): AgentEvent[] {
    const from = options.since ? this.events.findIndex((event) => event.id === options.since) + 1 : 0
    const newestFirst = this.events.slice(from).reverse()
    return options.limit ? newestFirst.slice(0, options.limit) : newestFirst
  }

  public get size(): number {
    return this.events.length
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn vitest run src/agent/__tests__/journal.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Format, typecheck, commit**

```bash
yarn prettier --check src/agent/journal.ts src/agent/__tests__/journal.test.ts
yarn typecheck
git add src/agent/journal.ts src/agent/__tests__/journal.test.ts
git -c core.safecrlf=false commit -m "feat(agent): a journal of the agent's own events

The Trust Lens audit records the orchestrator's decisions; nothing recorded the relying party's
side. A typed ring buffer with \`since\` for a poller, kept apart from AuditLog because the event
set and the reader are different.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The state — `src/agent/state.ts`

**Files:**

- Create: `src/agent/state.ts`
- Test: `src/agent/__tests__/state.test.ts`

**Interfaces:**

- Consumes: `AgentJournal`, `AgentEvent` (Task 1); `InTaskOpenId4VpAuthorizationResult` (`src/agent/extension.ts`); `StatusCheck` (`src/shared/presented-credential.ts`); `NO_PRESENTATION_IN_TIME` (`src/shared/authorization-result.ts`).
- Produces: `interface TaskStep { at; state; text? }`, `interface TaskView { id; contextId; state; startedAt; updatedAt; steps: TaskStep[]; sessionId?; result?; error? }`, `type PresentationSummary`, `interface AuthorizationRecord { sessionId; taskId; contextId; requestedAt; sessionState; expiresAt; verifiedAt?; presentation?; status?; outcome?; reason?; decidedAt? }`, `interface ChannelView { state: 'connecting' | 'open' | 'closed'; since; reconnects; lastError? }`, `class AgentState` with `journal`, `tasks`, `authorizations`, `authorizedContexts`, `channel`, and methods `taskStep`, `authorizationRequested`, `sessionState`, `statusChecked`, `authorizationDecided`, `channelState`, `channelError`, `llmFallback`, `forgetAuthorizations`, `isDecided`, `listTasks`, `listAuthorizations`, `counts`.

- [ ] **Step 1: Write the failing test**

Create `src/agent/__tests__/state.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { NO_PRESENTATION_IN_TIME } from '../../shared/authorization-result'
import { AgentState } from '../state'

const STATUS = {
  statusListCredential: 'http://localhost:3000/credentials/status/list-1',
  statusListIndex: 3,
  revoked: false,
  checkedAt: '2026-09-28T10:00:05.000Z',
}

function requested(state: AgentState, sessionId = 'sess-1', taskId = 't1', contextId = 'c1') {
  state.taskStep(taskId, contextId, 'submitted')
  state.taskStep(taskId, contextId, 'working', 'Reconciling…')
  state.taskStep(taskId, contextId, 'auth-required', 'Present a credential.')
  state.authorizationRequested({ sessionId, taskId, contextId, expiresAt: '2026-09-28T10:03:00.000Z' })
}

const types = (state: AgentState) => state.journal.list().map((event) => event.type)

describe('AgentState tasks', () => {
  it('indexes a task from its steps and keeps the result or the error', () => {
    const state = new AgentState()
    state.taskStep('t1', 'c1', 'submitted')
    state.taskStep('t1', 'c1', 'working', 'Reconciling…')
    state.taskStep('t1', 'c1', 'completed', 'Payment export prepared.')
    state.taskStep('t2', 'c2', 'submitted')
    state.taskStep('t2', 'c2', 'failed', 'Agent error: boom')

    const [newest, oldest] = state.listTasks()
    expect(oldest).toMatchObject({ id: 't1', contextId: 'c1', state: 'completed', result: 'Payment export prepared.' })
    expect(oldest.steps.map((step) => step.state)).toEqual(['submitted', 'working', 'completed'])
    expect(newest).toMatchObject({ id: 't2', state: 'failed', error: 'Agent error: boom' })
    expect(types(state).filter((type) => type === 'task.state')).toHaveLength(5)
    expect(state.journal.list()[0]).toMatchObject({ taskId: 't2', contextId: 'c2', text: 'failed: Agent error: boom' })
  })
})

describe('AgentState authorizations', () => {
  it('records the request on the task and journals it with the deadline', () => {
    const state = new AgentState()
    requested(state)

    expect(state.tasks.get('t1')?.sessionId).toBe('sess-1')
    expect(state.listAuthorizations()[0]).toMatchObject({
      sessionId: 'sess-1',
      taskId: 't1',
      contextId: 'c1',
      sessionState: 'RequestCreated',
      expiresAt: '2026-09-28T10:03:00.000Z',
    })
    expect(state.journal.list()[0]).toMatchObject({ type: 'auth.requested', sessionId: 'sess-1', taskId: 't1' })
    expect(state.isDecided('sess-1')).toBe(false)
  })

  it('follows the session, journals verification once, and ignores sessions it did not open', () => {
    const state = new AgentState()
    requested(state)
    state.sessionState('sess-1', 'RequestUriRetrieved')
    state.sessionState('sess-1', 'RequestUriRetrieved')
    state.sessionState('sess-1', 'ResponseVerified')
    state.sessionState('someone-elses', 'ResponseVerified')

    const record = state.authorizations.get('sess-1')
    expect(record?.sessionState).toBe('ResponseVerified')
    expect(record?.verifiedAt).toBeDefined()
    expect(types(state).slice(0, 3)).toEqual(['auth.verified', 'session.state', 'session.state'])
    expect(state.authorizations.has('someone-elses')).toBe(false)
  })

  it('keeps the status check and the authorized presentation, and remembers the context', () => {
    const state = new AgentState()
    requested(state)
    state.sessionState('sess-1', 'ResponseVerified')
    state.statusChecked('sess-1', STATUS)
    state.authorizationDecided({
      sessionId: 'sess-1',
      outcome: 'authorized',
      claims: { role: 'Finance Data Officer', org: 'Acme Corp GmbH' },
      issuer: 'did:hedera:testnet:trustco',
      holder: 'did:key:z6MkHolder#key-1',
      credentialType: 'urn:heka:role-credential:v1',
      status: STATUS,
      vpToken: 'eyJ.secret.token~',
      verifiedAt: '2026-09-28T10:00:04.000Z',
    })

    const record = state.authorizations.get('sess-1')
    expect(record).toMatchObject({ outcome: 'authorized', status: STATUS })
    expect(record?.presentation).toEqual({
      claims: { role: 'Finance Data Officer', org: 'Acme Corp GmbH' },
      issuer: 'did:hedera:testnet:trustco',
      holder: 'did:key:z6MkHolder#key-1',
      credentialType: 'urn:heka:role-credential:v1',
      verifiedAt: '2026-09-28T10:00:04.000Z',
    })
    expect(JSON.stringify(record)).not.toContain('secret.token')
    expect(state.authorizedContexts.has('c1')).toBe(true)
    expect(state.isDecided('sess-1')).toBe(true)
    expect(types(state).slice(0, 2)).toEqual(['auth.authorized', 'status.checked'])
    expect(state.journal.list()[1].data).toEqual({
      statusListCredential: STATUS.statusListCredential,
      statusListIndex: 3,
      revoked: false,
    })
    expect(state.counts()).toEqual({ tasks: 1, authorized: 1, denied: 0, contexts: 1 })
  })

  it('records a denial with what was verified but without claims, and a timeout as a denial', () => {
    const state = new AgentState()
    requested(state)
    state.authorizationDecided({
      sessionId: 'sess-1',
      outcome: 'denied',
      reason: 'the Finance Data Officer credential has been revoked by its issuer',
      issuer: 'did:hedera:testnet:trustco',
      holder: 'did:key:z6MkHolder#key-1',
      credentialType: 'urn:heka:role-credential:v1',
      status: { ...STATUS, revoked: true },
      vpToken: 'eyJ.secret.token~',
    })
    requested(state, 'sess-2', 't2', 'c2')
    state.authorizationDecided({ sessionId: 'sess-2', outcome: 'denied', reason: NO_PRESENTATION_IN_TIME })

    const revoked = state.authorizations.get('sess-1')
    expect(revoked).toMatchObject({ outcome: 'denied', reason: expect.stringContaining('revoked') })
    expect(revoked?.presentation).toEqual({
      claims: undefined,
      issuer: 'did:hedera:testnet:trustco',
      holder: 'did:key:z6MkHolder#key-1',
      credentialType: 'urn:heka:role-credential:v1',
      verifiedAt: undefined,
    })
    expect(revoked?.status?.revoked).toBe(true)
    expect(state.authorizations.get('sess-2')).toMatchObject({ outcome: 'denied', reason: NO_PRESENTATION_IN_TIME })
    expect(state.authorizations.get('sess-2')?.presentation).toBeUndefined()
    expect(state.authorizedContexts.size).toBe(0)
    expect(state.journal.list()[0]).toMatchObject({
      type: 'auth.denied',
      sessionId: 'sess-2',
      data: { reason: NO_PRESENTATION_IN_TIME },
    })
    expect(state.counts()).toEqual({ tasks: 2, authorized: 0, denied: 2, contexts: 0 })
  })

  it('forgets the authorized contexts and says how many', () => {
    const state = new AgentState()
    state.authorizedContexts.add('c1').add('c2')

    expect(state.forgetAuthorizations()).toBe(2)
    expect(state.authorizedContexts.size).toBe(0)
    expect(state.journal.list()[0]).toMatchObject({ type: 'authorizations.cleared', data: { cleared: 2 } })
    expect(state.forgetAuthorizations()).toBe(0)
  })
})

describe('AgentState channel', () => {
  it('counts reconnects, keeps the last error until the channel reopens, and journals open/closed', () => {
    const state = new AgentState()
    expect(state.channel).toMatchObject({ state: 'connecting', reconnects: 0 })

    state.channelState('open')
    expect(state.channel).toMatchObject({ state: 'open', reconnects: 0 })

    state.channelError('socket hang up')
    state.channelState('closed', 'code 1006')
    expect(state.channel).toMatchObject({ state: 'closed', reconnects: 0, lastError: 'socket hang up' })

    state.channelState('connecting')
    expect(state.channel).toMatchObject({ state: 'connecting', lastError: 'socket hang up' })

    state.channelState('open')
    expect(state.channel).toMatchObject({ state: 'open', reconnects: 1 })
    expect(state.channel.lastError).toBeUndefined()
    expect(types(state)).toEqual(['channel.open', 'channel.closed', 'channel.open'])
    expect(state.journal.list()[1].text).toBe('notification channel closed (code 1006)')
  })

  it('journals an LLM fallback against the task', () => {
    const state = new AgentState()
    state.llmFallback('t1', 'c1', 'connect ECONNREFUSED')
    expect(state.journal.list()[0]).toMatchObject({
      type: 'llm.fallback',
      taskId: 't1',
      contextId: 'c1',
      data: { reason: 'connect ECONNREFUSED' },
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest run src/agent/__tests__/state.test.ts`
Expected: FAIL — `Cannot find module '../state'`.

- [ ] **Step 3: Write the state**

Create `src/agent/state.ts`:

```ts
/**
 * What the server view reads: a task index, the authorization records, the channel's health and
 * the authorized-context cache — fed by the executor at the points where it already logs, and
 * journaled as it goes.
 *
 * Kept apart from the A2A task store on purpose. `InMemoryTaskStore` cannot list, and the page
 * wants the agent's own reading of what happened — a step per status update, the verifier
 * session's progress, the status check it ran — rather than the SDK's task object.
 */

import { InTaskOpenId4VpAuthorizationResult } from './extension'
import { AgentJournal } from './journal'
import { StatusCheck } from '../shared/presented-credential'

export interface TaskStep {
  at: string
  state: string
  text?: string
}

export interface TaskView {
  id: string
  contextId: string
  state: string
  startedAt: string
  updatedAt: string
  steps: TaskStep[]
  sessionId?: string
  result?: string
  error?: string
}

/**
 * What was verified, minus the token: the compact VP stays with the Trust Lens audit. Built from
 * the same result the client receives, so a denial carries no claims here either — nothing was
 * authorized, so nothing was disclosed to anyone.
 */
export type PresentationSummary = Pick<
  InTaskOpenId4VpAuthorizationResult,
  'claims' | 'issuer' | 'holder' | 'credentialType' | 'verifiedAt'
>

export interface AuthorizationRecord {
  sessionId: string
  taskId: string
  contextId: string
  requestedAt: string
  /** Heka's verification-session state as last seen (RequestCreated → RequestUriRetrieved → ResponseVerified). */
  sessionState: string
  /** The agent's own deadline, not the session's lifetime. */
  expiresAt: string
  verifiedAt?: string
  presentation?: PresentationSummary
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

const ids = (record: Pick<AuthorizationRecord, 'taskId' | 'contextId' | 'sessionId'>) => ({
  taskId: record.taskId,
  contextId: record.contextId,
  sessionId: record.sessionId,
})

export class AgentState {
  public readonly journal: AgentJournal
  public readonly tasks = new Map<string, TaskView>()
  public readonly authorizations = new Map<string, AuthorizationRecord>()
  /** Contexts whose sensitive step was authorized once; a later task in one of them skips the request. */
  public readonly authorizedContexts = new Set<string>()
  public channel: ChannelView = { state: 'connecting', since: new Date().toISOString(), reconnects: 0 }
  private opens = 0

  public constructor(journal = new AgentJournal()) {
    this.journal = journal
  }

  // ---------- tasks ----------

  public taskStep(taskId: string, contextId: string, state: string, text?: string): void {
    const at = new Date().toISOString()
    let task = this.tasks.get(taskId)
    if (!task) {
      task = { id: taskId, contextId, state, startedAt: at, updatedAt: at, steps: [] }
      this.tasks.set(taskId, task)
    }
    task.state = state
    task.updatedAt = at
    task.steps.push({ at, state, text })
    if (state === 'completed') task.result = text
    if (state === 'failed') task.error = text
    this.journal.record({ type: 'task.state', taskId, contextId, text: text ? `${state}: ${text}` : state })
  }

  /** Newest first: the task you just started is the one you look for. */
  public listTasks(): TaskView[] {
    return [...this.tasks.values()].reverse()
  }

  // ---------- authorizations ----------

  public authorizationRequested(
    record: Pick<AuthorizationRecord, 'sessionId' | 'taskId' | 'contextId' | 'expiresAt'>
  ): void {
    this.authorizations.set(record.sessionId, {
      ...record,
      requestedAt: new Date().toISOString(),
      sessionState: 'RequestCreated',
    })
    const task = this.tasks.get(record.taskId)
    if (task) task.sessionId = record.sessionId
    this.journal.record({
      type: 'auth.requested',
      ...ids(record),
      text: `authorization requested; the agent waits until ${record.expiresAt}`,
      data: { expiresAt: record.expiresAt },
    })
  }

  /**
   * Only sessions this agent opened are known here; the AS's sessions on the shared tenant never
   * reach this method with a record and are dropped. A repeated state is not a change.
   */
  public sessionState(sessionId: string, state: string): void {
    const record = this.authorizations.get(sessionId)
    if (!record || record.sessionState === state) return
    record.sessionState = state
    this.journal.record({ type: 'session.state', ...ids(record), text: `session ${state}` })
    if (state === 'ResponseVerified') {
      record.verifiedAt = new Date().toISOString()
      this.journal.record({
        type: 'auth.verified',
        ...ids(record),
        text: 'presentation verified by Heka; the agent now judges the credential itself',
      })
    }
  }

  public statusChecked(sessionId: string, status: StatusCheck): void {
    const record = this.authorizations.get(sessionId)
    if (!record) return
    record.status = status
    this.journal.record({
      type: 'status.checked',
      ...ids(record),
      text: `status list index ${status.statusListIndex} -> ${status.revoked ? 'revoked' : 'live'}`,
      data: {
        statusListCredential: status.statusListCredential,
        statusListIndex: status.statusListIndex,
        revoked: status.revoked,
      },
    })
  }

  /** The decision, from the same result the client is told — one rule for both sides. */
  public authorizationDecided(result: InTaskOpenId4VpAuthorizationResult): void {
    const record = this.authorizations.get(result.sessionId)
    if (!record) return
    record.outcome = result.outcome
    record.reason = result.reason
    record.decidedAt = new Date().toISOString()
    if (result.status && !record.status) record.status = result.status
    if (result.issuer || result.holder || result.credentialType) {
      record.presentation = {
        claims: result.claims,
        issuer: result.issuer,
        holder: result.holder,
        credentialType: result.credentialType,
        verifiedAt: result.verifiedAt,
      }
    }

    if (result.outcome === 'authorized') {
      this.authorizedContexts.add(record.contextId)
      const claims = Object.entries(result.claims ?? {})
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(', ')
      this.journal.record({
        type: 'auth.authorized',
        ...ids(record),
        text: `authorized${claims ? ` (${claims})` : ''}; context ${record.contextId.slice(0, 8)} remembered`,
        data: { claims: result.claims, issuer: result.issuer, holder: result.holder },
      })
      return
    }
    this.journal.record({
      type: 'auth.denied',
      ...ids(record),
      text: `denied: ${result.reason ?? 'no reason given'}`,
      data: { reason: result.reason, issuer: result.issuer, holder: result.holder },
    })
  }

  /** True once the record is settled; a pending one is still being waited on. */
  public isDecided(sessionId: string): boolean {
    return Boolean(this.authorizations.get(sessionId)?.outcome)
  }

  public listAuthorizations(): AuthorizationRecord[] {
    return [...this.authorizations.values()].reverse()
  }

  /** Returns how many contexts were forgotten; the next task in each will ask again. */
  public forgetAuthorizations(): number {
    const cleared = this.authorizedContexts.size
    this.authorizedContexts.clear()
    this.journal.record({
      type: 'authorizations.cleared',
      text: `${cleared} authorized context${cleared === 1 ? '' : 's'} forgotten; the next task in each asks again`,
      data: { cleared },
    })
    return cleared
  }

  public counts(): { tasks: number; authorized: number; denied: number; contexts: number } {
    const records = [...this.authorizations.values()]
    return {
      tasks: this.tasks.size,
      authorized: records.filter((record) => record.outcome === 'authorized').length,
      denied: records.filter((record) => record.outcome === 'denied').length,
      contexts: this.authorizedContexts.size,
    }
  }

  // ---------- channel ----------

  public channelState(state: ChannelView['state'], detail?: string): void {
    const since = new Date().toISOString()
    if (state === 'open') {
      this.opens++
      this.channel = { state, since, reconnects: this.opens - 1 }
      this.journal.record({ type: 'channel.open', text: 'notification channel open' })
      return
    }
    this.channel = { ...this.channel, state, since }
    if (state === 'closed') {
      this.journal.record({
        type: 'channel.closed',
        text: `notification channel closed${detail ? ` (${detail})` : ''}`,
        data: { detail },
      })
    }
  }

  /** Socket errors precede the close; kept for the page, not journaled — the close is the event. */
  public channelError(message: string): void {
    this.channel = { ...this.channel, lastError: message }
  }

  // ---------- llm ----------

  public llmFallback(taskId: string, contextId: string, reason: string): void {
    this.journal.record({
      type: 'llm.fallback',
      taskId,
      contextId,
      text: `LLM unavailable (${reason}); the deterministic report was used`,
      data: { reason },
    })
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn vitest run src/agent/__tests__/state.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Format, typecheck, commit**

```bash
yarn prettier --check src/agent/state.ts src/agent/__tests__/state.test.ts
yarn typecheck
git add src/agent/state.ts src/agent/__tests__/state.test.ts
git -c core.safecrlf=false commit -m "feat(agent): a state view — tasks, authorization records, channel health

InMemoryTaskStore cannot list and knows nothing about the verifier session, so the page needs the
agent's own index. Records are built from the same result the client receives: a denial carries
issuer, holder and status but no claims, and the token never leaves the audit.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The LLM fallback callback — `src/agent/invoice-work.ts`

**Files:**

- Modify: `src/agent/invoice-work.ts:34-66`

**Interfaces:**

- Produces: `LLM_MODEL: string`, `llmEnabled(): boolean`, `prepareInvoiceReport(prompt: string, onFallback?: (reason: string) => void): Promise<string>`.

- [ ] **Step 1: Change the module**

Replace lines 34–66 of `src/agent/invoice-work.ts` (from `async function llmReport` to the end) with:

```ts
export const LLM_MODEL = 'gpt-4o-mini'

/** Whether the agent narrates; the page shows this, and `/api/state` reports it. */
export function llmEnabled(): boolean {
  const key = process.env.OPENAI_API_KEY
  return Boolean(key && !key.startsWith('your_'))
}

async function llmReport(prompt: string): Promise<string> {
  const { genkit } = await import('genkit')
  const { openAI } = await import('@genkit-ai/compat-oai/openai')

  const ai = genkit({ plugins: [openAI()], model: openAI.model(LLM_MODEL) })

  const { text } = await ai.generate({
    prompt: [
      'You are a supplier invoice reconciliation agent for Acme Corp.',
      'Summarise the prepared payment export in at most 8 short lines. Be factual and plain.',
      '',
      'Reconciled invoices:',
      ...INVOICES.map((i) => `- ${i.invoice} ${i.supplier} ${i.amount} (${i.status})`),
      '',
      `Operator request: ${prompt}`,
    ].join('\n'),
  })

  return text?.trim() || deterministicReport()
}

/** `onFallback` is told why the LLM was not used at run time; a missing key is not a fallback, it is the default. */
export async function prepareInvoiceReport(prompt: string, onFallback?: (reason: string) => void): Promise<string> {
  if (!llmEnabled()) {
    return deterministicReport()
  }

  try {
    return await llmReport(prompt)
  } catch (error) {
    const reason = (error as Error).message
    console.log(`[agent] LLM unavailable (${reason}); using the deterministic report`)
    onFallback?.(reason)
    return deterministicReport()
  }
}
```

- [ ] **Step 2: Typecheck, format, commit**

```bash
yarn typecheck
yarn prettier --check src/agent/invoice-work.ts
git add src/agent/invoice-work.ts
git -c core.safecrlf=false commit -m "feat(agent): say when the LLM fell back, and whether it is on at all

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Wire the executor — SDK task id, cancel, journaled sessions, forget

**Files:**

- Modify: `src/agent/index.ts` (imports; `InvoiceAgentExecutor` whole class; `main`)

**Interfaces:**

- Consumes: `AgentState` (Task 2); `prepareInvoiceReport(prompt, onFallback)` (Task 3).
- Produces (read by Task 5): `InvoiceAgentExecutor.verifierDid: string | null` (public), `InvoiceAgentExecutor.state: AgentState` (public readonly), `InvoiceAgentExecutor.forgetAuthorizations(): number`.

- [ ] **Step 1: Imports**

In `src/agent/index.ts`, change line 58 and add the two module imports:

```ts
import { llmEnabled, LLM_MODEL, prepareInvoiceReport, SENSITIVE_STEP } from './invoice-work'
import { AgentState } from './state'
```

(`mountServerView` and `ACME_DOMAIN` are imported in Task 5; `llmEnabled` / `LLM_MODEL` are used there too — importing them now is fine, the typecheck's `noUnusedLocals` is not set. Check with `grep noUnused tsconfig.json`; if it is set, add these two in Task 5 instead.)

- [ ] **Step 2: A cancellation error next to `AuthorizationDenied`**

After the `AuthorizationDenied` class (line 156), add:

```ts
/** Thrown inside the wait loop once `tasks/cancel` set the flag: the execution stops without another update. */
class TaskCancelled extends Error {
  public constructor() {
    super('task cancelled')
    this.name = 'TaskCancelled'
  }
}
```

- [ ] **Step 3: Replace the executor's fields, constructor and channel code (lines 158–213)**

```ts
class InvoiceAgentExecutor implements AgentExecutor {
  /** Sessions this agent opened, by id — the filter that keeps the AS's sessions out. */
  private readonly sessionToContext = new Map<string, string>()
  /** Latest Heka state per session this agent opened — what `authorizationStatus` forwards. */
  private readonly sessionStates = new Map<string, string>()
  private readonly cancelled = new Set<string>()

  /** Read by the server view once `initialize` has run. */
  public verifierDid: string | null = null

  public constructor(
    private readonly identityService: IdentityServiceClient,
    public readonly state: AgentState
  ) {}

  public async initialize(): Promise<void> {
    this.verifierDid = await this.identityService.prepareWallet()
    console.log(`[agent] verifier identity: ${this.verifierDid}`)
    this.connectNotifications()
  }

  /**
   * Heka pushes verification-session state changes over a WebSocket. The socket does not
   * survive a restart of the Identity Service (re-creating its container to change the
   * advertised OID4VC address is a documented step), so reconnect rather than go deaf — and
   * `waitForVerifiedPresentation` also asks Heka directly, in case a state change fell into the gap.
   */
  private connectNotifications(): void {
    this.state.channelState('connecting')
    const socket = new WebSocket(this.identityService.notificationsUrl(), {
      headers: { Authorization: `Bearer ${process.env.IDENTITY_SERVICE_ACCESS_TOKEN}` },
    })
    socket.on('open', () => {
      console.log('[agent] notification channel open')
      this.state.channelState('open')
    })
    socket.on('error', (error: Error) => {
      console.log(`[agent] notification error: ${error.message}`)
      this.state.channelError(error.message)
    })
    socket.on('message', (raw: Buffer) => this.onNotification(raw))
    socket.on('close', (code: number) => {
      console.log(`[agent] notification channel closed (${code}); reconnecting in 3s`)
      this.state.channelState('closed', `code ${code}`)
      setTimeout(() => this.connectNotifications(), 3000)
    })
  }

  private onNotification(raw: Buffer): void {
    let message: { type?: string; verificationSession?: { id?: string; state?: string } }
    try {
      message = JSON.parse(raw.toString())
    } catch {
      return
    }

    const session = message.verificationSession
    if (message.type !== 'OpenId4VcVerifier.VerificationSessionStateChanged' || !session?.id) return

    // Heka notifies for every session in the tenant, the AS's included; only ours are tracked.
    if (!this.sessionToContext.has(session.id)) return
    console.log(`[agent] session ${session.id.slice(0, 8)} -> ${session.state}`)
    if (session.state) this.noteSessionState(session.id, session.state)
  }

  /** One entry point for the WebSocket and the poll fallback, so a state is journaled once. */
  private noteSessionState(sessionId: string, state: string): void {
    if (this.sessionStates.get(sessionId) === state) return
    this.sessionStates.set(sessionId, state)
    this.state.sessionState(sessionId, state)
  }

  /**
   * The SDK calls this on `tasks/cancel` and then waits for a final event on the task's bus, so
   * the cancellation is published here; the running execution sees the flag and stops without
   * another update. A pending verifier session is left to expire on its own.
   */
  public cancelTask = async (taskId: string, eventBus: ExecutionEventBus): Promise<void> => {
    this.cancelled.add(taskId)
    const contextId = this.state.tasks.get(taskId)?.contextId ?? ''
    eventBus.publish({
      kind: 'status-update',
      taskId,
      contextId,
      status: { state: 'canceled', timestamp: new Date().toISOString() },
      final: true,
    })
    this.state.taskStep(taskId, contextId, 'canceled', 'Cancelled by the client.')
  }

  /**
   * Forget which contexts were authorized, for the revocation demo on a reused context. Sessions
   * still being waited on keep their state; only decided ones are pruned from the maps.
   */
  public forgetAuthorizations(): number {
    for (const sessionId of [...this.sessionToContext.keys()]) {
      if (this.state.isDecided(sessionId)) {
        this.sessionToContext.delete(sessionId)
        this.sessionStates.delete(sessionId)
      }
    }
    return this.state.forgetAuthorizations()
  }
```

- [ ] **Step 4: Replace `execute` (lines 215–303)**

```ts
  public async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const userMessage = context.userMessage
    // The SDK's id: it keys the task's event bus by it, so `tasks/cancel` finds the running task.
    const taskId = context.taskId
    const contextId = userMessage.contextId ?? context.task?.contextId ?? randomUUID()

    if (!context.task) {
      eventBus.publish({
        kind: 'task',
        id: taskId,
        contextId,
        status: { state: 'submitted', timestamp: new Date().toISOString() },
        history: [userMessage],
        metadata: userMessage.metadata,
      })
      this.state.taskStep(taskId, contextId, 'submitted')
    }

    const say = (state: 'working' | 'auth-required' | 'completed' | 'failed', text: string, extra?: object) => {
      const update: TaskStatusUpdateEvent = {
        kind: 'status-update',
        taskId,
        contextId,
        status: {
          state,
          message: {
            kind: 'message',
            role: 'agent',
            messageId: randomUUID(),
            parts: [{ kind: 'text', text }],
            taskId,
            contextId,
            ...(extra ?? {}),
          },
          timestamp: new Date().toISOString(),
        },
        final: state === 'completed' || state === 'failed',
      }
      eventBus.publish(update)
      this.state.taskStep(taskId, contextId, state, text)
    }

    // Set only when this task ran the authorization itself; a context authorized earlier has none.
    let result: InTaskOpenId4VpAuthorizationResult | undefined

    try {
      say('working', 'Reconciling supplier invoices for the period…')

      // Routine work needs no authorization; only the export does.
      if (!this.state.authorizedContexts.has(contextId)) {
        say('working', `Reconciliation complete. ${SENSITIVE_STEP} requires authorization.`)

        const { request, sessionId, expiresAt } = await this.requestAuthorization(taskId, contextId)
        const statusOf = (state: string): InTaskOpenId4VpAuthorizationStatus => ({
          sessionId,
          state,
          expiresAt,
          requested: OFFICER_REQUESTED,
        })

        say('auth-required', 'Present a Finance Data Officer credential to authorize the payment export.', {
          metadata: withExtension({ authorizationRequest: request, authorizationStatus: statusOf('RequestCreated') }),
        })

        const { presented, status } = await this.awaitAuthorization(taskId, sessionId, expiresAt, (state) => {
          const text = SESSION_STATE_TEXT[state]
          if (text) say('working', text, { metadata: withExtension({ authorizationStatus: statusOf(state) }) })
        })
        result = authorizedResult(presented, status)
        this.state.authorizationDecided(result)
        console.log(`[agent] context ${contextId.slice(0, 8)} authorized`)
        say('working', 'Authorization accepted. Preparing the payment export…')
      }

      // Cancelled while waiting: `canceled` was already published; anything more would reopen the task.
      if (this.cancelled.has(taskId)) return

      const report = await prepareInvoiceReport(collectText(context), (reason) =>
        this.state.llmFallback(taskId, contextId, reason)
      )
      if (this.cancelled.has(taskId)) return
      say('completed', report, result ? { metadata: withExtension({ authorizationResult: result }) } : undefined)
    } catch (error) {
      if (error instanceof TaskCancelled) return
      const denied = error instanceof AuthorizationDenied
      console.log(`[agent] task ${taskId.slice(0, 8)} ${denied ? 'denied' : 'failed'}: ${(error as Error).message}`)
      const message = (error as Error).message
      if (denied && error.result) this.state.authorizationDecided(error.result)
      say(
        'failed',
        denied ? `Authorization denied: ${message}` : `Agent error: ${message}`,
        denied && error.result ? { metadata: withExtension({ authorizationResult: error.result }) } : undefined
      )
    } finally {
      this.cancelled.delete(taskId)
    }
  }
```

- [ ] **Step 5: Replace `requestAuthorization` and `awaitAuthorization` (lines 305–377)**

```ts
  private async requestAuthorization(taskId: string, contextId: string) {
    const response = await this.identityService.createVerificationSession({
      publicVerifierId: this.verifierDid as string,
      requestSigner: { method: 'did', did: this.verifierDid as string },
      presentationExchange: { definition: OFFICER_PRESENTATION_DEFINITION },
    })

    const sessionId = response.verificationSession.id
    // The agent's own deadline; the verifier session has a shorter lifetime Heka does not expose.
    const expiresAt = new Date(Date.now() + AUTHORIZATION_TIMEOUT_MS).toISOString()
    this.sessionToContext.set(sessionId, contextId)
    this.state.authorizationRequested({ sessionId, taskId, contextId, expiresAt })
    console.log(
      `[agent] authorization requested: session ${sessionId.slice(0, 8)} for context ${contextId.slice(0, 8)}`
    )

    return {
      sessionId,
      expiresAt,
      request: {
        client_id: this.verifierDid as string,
        request_uri: response.authorizationRequest,
      } as InTaskOpenId4VpAuthorizationRequest,
    }
  }

  private async awaitAuthorization(
    taskId: string,
    sessionId: string,
    expiresAt: string,
    onState: (state: string) => void
  ): Promise<{ presented: PresentedCredential; status: StatusCheck }> {
    await this.waitForVerifiedPresentation(taskId, sessionId, Date.parse(expiresAt), onState)

    // Heka verified the signature and the key binding. Whether this relying party accepts the
    // credential — its issuer, its type, and whether it is still live — is decided here, against
    // the presented token itself. Never against a seed slot: the slot says what was issued, the
    // token says what was shown.
    const trustedIssuer = loadState().issuerDid
    if (!trustedIssuer) throw new AuthorizationDenied('no trusted issuer configured — run `yarn seed`')

    // Declared outside the try so a refusal can still log which status pointer it was judged on.
    let presented: PresentedCredential | undefined
    try {
      presented = readPresentedCredential(await this.identityService.getVerificationSession(sessionId))
      const status = await assertPresentedCredentialValid(
        presented,
        {
          trustedIssuers: [trustedIssuer],
          requiredVct: ROLE_CREDENTIAL_VCT,
          statusListOrigin: this.identityService.baseOrigin,
          credentialLabel: OFFICER_CREDENTIAL.role,
          requiredClaims: { role: OFFICER_CREDENTIAL.role },
        },
        fetch
      )
      console.log(`[agent] status checked: index ${status.statusListIndex} on ${status.statusListCredential} -> live`)
      this.state.statusChecked(sessionId, status)
      return { presented, status }
    } catch (error) {
      if (error instanceof PresentationRefused) {
        if (error.reason === 'revoked' && presented?.credentialStatus) {
          const { statusListIndex, statusListCredential } = presented.credentialStatus
          console.log(`[agent] status checked: index ${statusListIndex} on ${statusListCredential} -> revoked`)
          this.state.statusChecked(sessionId, {
            statusListCredential,
            statusListIndex,
            revoked: true,
            checkedAt: new Date().toISOString(),
          })
        }
        if (error.reason === 'foreign-status-list' && presented?.credentialStatus) {
          const origin = statusListOriginOf(presented.credentialStatus) ?? '(not a URL)'
          console.log(`[agent] status list origin ${origin} is not ${this.identityService.baseOrigin}`)
        }
        console.log(`[agent] presentation refused (${error.reason}): ${error.message}`)
        throw new AuthorizationDenied(error.message, deniedResult(sessionId, error.message, presented, error.reason))
      }
      throw error
    }
  }
```

- [ ] **Step 6: Replace `waitForVerifiedPresentation` (lines 379–424)**

```ts
  /**
   * Resolve once Heka reports `ResponseVerified`, calling `onState` on every state change on the
   * way (the wallet fetching the request is the first sign of life the operator can see). The
   * WebSocket is the fast path; every few seconds Heka is asked directly in case a notification
   * fell into a reconnect gap. A cancelled task stops waiting on the next tick.
   */
  private waitForVerifiedPresentation(
    taskId: string,
    sessionId: string,
    deadline: number,
    onState: (state: string) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let reported = 'RequestCreated'
      let ticks = 0
      let checking = false
      const poll = setInterval(async () => {
        if (this.cancelled.has(taskId)) {
          clearInterval(poll)
          reject(new TaskCancelled())
          return
        }
        const state = this.sessionStates.get(sessionId)
        if (state && state !== reported) {
          reported = state
          onState(state)
        }
        if (state === 'ResponseVerified') {
          clearInterval(poll)
          resolve()
          return
        }
        if (Date.now() > deadline) {
          clearInterval(poll)
          reject(new AuthorizationDenied(NO_PRESENTATION_IN_TIME, deniedResult(sessionId, NO_PRESENTATION_IN_TIME)))
          return
        }
        // Belt and braces: every few seconds, ask Heka in case the notification never came.
        if (++ticks % 6 === 0 && !checking) {
          checking = true
          try {
            const session = await this.identityService.getVerificationSession(sessionId)
            if (session.state) this.noteSessionState(sessionId, session.state)
          } catch {
            // Transient; the next tick tries again and the deadline still bounds the wait.
          } finally {
            checking = false
          }
        }
      }, 500)
    })
  }
}
```

- [ ] **Step 7: `main` builds the state and hands it to the executor**

Replace lines 438–451 (`async function main() { … }`) with:

```ts
async function main() {
  const identityService = identityServiceFromEnv()
  const state = new AgentState()

  const executor = new InvoiceAgentExecutor(identityService, state)
  await executor.initialize()

  const handler = new DefaultRequestHandler(agentCard(), new InMemoryTaskStore() as TaskStore, executor)
  const app = new A2AExpressApp(handler).setupRoutes(express())

  app.listen(PORT, () => {
    console.log(`[agent] Acme Invoice Agent on http://localhost:${PORT}`)
    console.log(`[agent] agent card: http://localhost:${PORT}/.well-known/agent-card.json`)
  })
}
```

- [ ] **Step 8: Typecheck, tests, format**

```bash
yarn typecheck
yarn test
yarn prettier --check src/agent/index.ts
```

Expected: typecheck clean; all tests pass (the T1–T3 suites plus journal and state).

- [ ] **Step 9: Commit**

```bash
git add src/agent/index.ts
git -c core.safecrlf=false commit -m "fix(agent): the SDK's task id, a real cancel, and every step journaled

The agent minted its own task id, so the SDK keyed the event bus by one id and the client saw
another: tasks/cancel could not find the running task. Now context.taskId is used, cancelTask
publishes the final canceled update the SDK waits for, and the wait loop stops on the flag.
Session states go through one method so the WebSocket and the poll fallback journal a change
once; the executor feeds the state view at every point it already logged.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The API — `src/agent/server-view.ts`, mounted before the A2A router

**Files:**

- Create: `src/agent/server-view.ts`
- Test: `src/agent/__tests__/server-view.test.ts`
- Modify: `src/agent/index.ts` (imports; `main`)

**Interfaces:**

- Consumes: `AgentState` (Task 2); `InvoiceAgentExecutor.verifierDid`, `.state`, `.forgetAuthorizations()` (Task 4); `llmEnabled`, `LLM_MODEL` (Task 3); `ACME_DOMAIN` (`src/shared/demo-config.ts`); `loadState()` (`src/seed/state.ts`); `IdentityServiceClient.baseOrigin`.
- Produces: `interface AgentIdentity`, `interface TrustSettings`, `interface ServerViewOptions`, `mountServerView(app: Express, options: ServerViewOptions): Express`. Routes: `GET /health`, `GET /api/state`, `GET /api/card`, `GET /api/tasks`, `GET /api/tasks/:id`, `GET /api/authorizations`, `GET /api/events?since=&limit=`, `POST /api/authorizations/forget`, static `/` (`src/agent/public`) and `/shared` (`src/web/public`).

- [ ] **Step 1: Write the failing test**

Create `src/agent/__tests__/server-view.test.ts`:

```ts
import { AddressInfo } from 'node:net'

import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { mountServerView } from '../server-view'
import { AgentState } from '../state'

const CARD = { name: 'Acme Invoice Agent', url: 'http://localhost:10003/' } as never

let base = ''
let close: () => void
const state = new AgentState()
let forgotten = 0

beforeAll(async () => {
  const app = express()
  mountServerView(app, {
    state,
    startedAt: new Date(Date.now() - 5_000).toISOString(),
    identity: () => ({
      name: 'Acme Invoice Agent',
      publicUrl: 'http://localhost:10003/',
      port: 10003,
      verifierDid: 'did:key:z6MkVerifier',
      resourceDid: 'did:hedera:testnet:acme-agent',
      authorizationTimeoutMs: 180_000,
      llm: { enabled: false },
    }),
    trust: () => ({ trustedIssuer: 'did:hedera:testnet:trustco', statusListOrigin: 'http://localhost:3000' }),
    card: () => CARD,
    staticCardUrl: 'https://acme-invoices.example/.well-known/agent-card.json',
    forgetAuthorizations: () => ++forgotten,
  })
  // Stands in for the A2A router: mounted after the view, it must still receive POST /.
  app.post('/', (_req, res) => res.json({ protocol: true }))

  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () => server.close()
})

afterAll(() => close())

const get = async (path: string) => {
  const response = await fetch(`${base}${path}`)
  return { status: response.status, body: await response.json() }
}

describe('server view API', () => {
  it('answers /health with the channel and the verifier identity', async () => {
    const { status, body } = await get('/health')
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, verifierDid: 'did:key:z6MkVerifier', channel: { state: 'connecting' } })
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(5)
  })

  it('describes the agent, its trust settings and the counts', async () => {
    const { body } = await get('/api/state')
    expect(body.agent).toMatchObject({
      name: 'Acme Invoice Agent',
      port: 10003,
      resourceDid: 'did:hedera:testnet:acme-agent',
      authorizationTimeoutMs: 180_000,
      llm: { enabled: false },
    })
    expect(body.trust).toEqual({
      trustedIssuer: 'did:hedera:testnet:trustco',
      statusListOrigin: 'http://localhost:3000',
    })
    expect(body.counts).toEqual({ tasks: 0, authorized: 0, denied: 0, contexts: 0 })
    expect(body.channel.state).toBe('connecting')
    expect(Date.parse(body.startedAt)).not.toBeNaN()
  })

  it('serves the live card next to the static card URL', async () => {
    const { body } = await get('/api/card')
    expect(body.live).toEqual(CARD)
    expect(body.staticCardUrl).toBe('https://acme-invoices.example/.well-known/agent-card.json')
    expect(body.note).toMatch(/digest/)
  })

  it('lists tasks newest first and 404s an unknown one', async () => {
    state.taskStep('t1', 'c1', 'submitted')
    state.taskStep('t2', 'c2', 'submitted')
    const { body } = await get('/api/tasks')
    expect(body.tasks.map((task: { id: string }) => task.id)).toEqual(['t2', 't1'])
    expect((await get('/api/tasks/t1')).body).toMatchObject({ id: 't1', contextId: 'c1' })
    expect((await get('/api/tasks/nope')).status).toBe(404)
  })

  it('lists authorizations and pages events with since and limit', async () => {
    state.authorizationRequested({
      sessionId: 's1',
      taskId: 't1',
      contextId: 'c1',
      expiresAt: '2026-09-28T10:03:00.000Z',
    })
    expect((await get('/api/authorizations')).body.authorizations[0]).toMatchObject({ sessionId: 's1', taskId: 't1' })

    const all = (await get('/api/events')).body.events
    expect(all[0].type).toBe('auth.requested')
    const older = all[1].id
    const since = (await get(`/api/events?since=${older}&limit=5`)).body.events
    expect(since.map((event: { id: string }) => event.id)).toEqual([all[0].id])
    expect((await get('/api/events?limit=2')).body.events).toHaveLength(2)
  })

  it('forgets authorizations through the one action it has', async () => {
    const response = await fetch(`${base}/api/authorizations/forget`, { method: 'POST' })
    expect(await response.json()).toEqual({ cleared: 1 })
    expect(forgotten).toBe(1)
  })

  it('leaves POST / to the protocol and serves the page on GET /', async () => {
    const post = await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(await post.json()).toEqual({ protocol: true })
    const page = await fetch(`${base}/`)
    expect(page.headers.get('content-type')).toMatch(/text\/html/)
    expect(await page.text()).toContain('Acme Invoice Agent')
    const css = await fetch(`${base}/shared/app.css`)
    expect(css.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest run src/agent/__tests__/server-view.test.ts`
Expected: FAIL — `Cannot find module '../server-view'`.

- [ ] **Step 3: Write the module**

Create `src/agent/server-view.ts`:

```ts
/**
 * The agent's server view: a read-only JSON API and a static page on the A2A port.
 *
 * Mounted on the same `express()` as the protocol, and before it, so `GET /` is the page while
 * `POST /` stays JSON-RPC — `express.static` answers GET and HEAD only and hands anything else on.
 * One action exists, Forget authorizations, for the revocation demo on a reused context; the
 * holder's and the client's actions stay in the Trust Lens.
 */

import { resolve } from 'node:path'

import { AgentCard } from '@a2a-js/sdk'
import express, { Express } from 'express'

import { AgentState } from './state'

export interface AgentIdentity {
  name: string
  publicUrl: string
  port: number
  /** The did:key Heka gave `prepare-wallet`; null until `initialize` has run. */
  verifierDid: string | null
  /** The did:hedera the Resource Passport attests — the seed's, not something the agent proves. */
  resourceDid?: string
  authorizationTimeoutMs: number
  llm: { enabled: boolean; model?: string }
}

export interface TrustSettings {
  trustedIssuer?: string
  statusListOrigin: string
}

export interface ServerViewOptions {
  state: AgentState
  startedAt: string
  /** Functions, not values: the verifier DID and the seed state are known only after boot and can change. */
  identity: () => AgentIdentity
  trust: () => TrustSettings
  card: () => AgentCard
  staticCardUrl: string
  forgetAuthorizations: () => number
}

export function mountServerView(app: Express, options: ServerViewOptions): Express {
  const { state } = options

  app.use(express.static(resolve(process.cwd(), 'src/agent/public')))
  // The page reuses the Trust Lens stylesheet and helpers; a relative link cannot escape a static root.
  app.use('/shared', express.static(resolve(process.cwd(), 'src/web/public')))

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      uptimeSeconds: Math.round((Date.now() - Date.parse(options.startedAt)) / 1000),
      verifierDid: options.identity().verifierDid,
      channel: state.channel,
    })
  })

  app.get('/api/state', (_req, res) => {
    res.json({
      agent: options.identity(),
      trust: options.trust(),
      channel: state.channel,
      counts: state.counts(),
      startedAt: options.startedAt,
    })
  })

  app.get('/api/card', (_req, res) => {
    res.json({
      live: options.card(),
      staticCardUrl: options.staticCardUrl,
      note: 'The digest-pinned card is served by the publisher site and is what the Trust Lens verifies; this live one is what A2A clients connect to.',
    })
  })

  app.get('/api/tasks', (_req, res) => {
    res.json({ tasks: state.listTasks() })
  })

  app.get('/api/tasks/:id', (req, res) => {
    const task = state.tasks.get(String(req.params.id))
    if (!task) {
      res.status(404).json({ error: 'no such task' })
      return
    }
    res.json(task)
  })

  app.get('/api/authorizations', (_req, res) => {
    res.json({ authorizations: state.listAuthorizations() })
  })

  app.get('/api/events', (req, res) => {
    const since = req.query.since ? String(req.query.since) : undefined
    const limit = Number(req.query.limit) || undefined
    res.json({ events: state.journal.list({ since, limit }) })
  })

  app.post('/api/authorizations/forget', (_req, res) => {
    res.json({ cleared: options.forgetAuthorizations() })
  })

  return app
}
```

- [ ] **Step 4: A placeholder page so the static test can pass**

Create `src/agent/public/index.html` with the final markup of Task 6 — or, to keep this task green on its own, the minimal file below, which Task 6 replaces:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Acme Invoice Agent — server view</title>
    <link rel="stylesheet" href="./shared/app.css" />
  </head>
  <body>
    <h1>Acme Invoice Agent</h1>
  </body>
</html>
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `yarn vitest run src/agent/__tests__/server-view.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Mount it in `main`**

In `src/agent/index.ts`, add the imports:

```ts
import { ACME_DOMAIN, OFFICER_CREDENTIAL } from '../shared/demo-config'
import { mountServerView } from './server-view'
```

(`OFFICER_CREDENTIAL` is already imported from `../shared/demo-config` on line 34 — extend that line rather than adding a second import.)

Replace `main` with:

```ts
async function main() {
  const startedAt = new Date().toISOString()
  const identityService = identityServiceFromEnv()
  const state = new AgentState()

  const executor = new InvoiceAgentExecutor(identityService, state)
  await executor.initialize()

  const handler = new DefaultRequestHandler(agentCard(), new InMemoryTaskStore() as TaskStore, executor)
  const app = express()
  // The server view first: `GET /` is the page, `POST /` (the A2A router, below) stays the protocol.
  mountServerView(app, {
    state,
    startedAt,
    identity: () => ({
      name: 'Acme Invoice Agent',
      publicUrl: PUBLIC_URL,
      port: PORT,
      verifierDid: executor.verifierDid,
      resourceDid: loadState().dids.acmeAgent,
      authorizationTimeoutMs: AUTHORIZATION_TIMEOUT_MS,
      llm: llmEnabled() ? { enabled: true, model: LLM_MODEL } : { enabled: false },
    }),
    trust: () => ({ trustedIssuer: loadState().issuerDid, statusListOrigin: identityService.baseOrigin }),
    card: agentCard,
    staticCardUrl: `https://${ACME_DOMAIN}/.well-known/agent-card.json`,
    forgetAuthorizations: () => executor.forgetAuthorizations(),
  })
  new A2AExpressApp(handler).setupRoutes(app)

  app.listen(PORT, () => {
    console.log(`[agent] Acme Invoice Agent on http://localhost:${PORT}`)
    console.log(`[agent] agent card: http://localhost:${PORT}/.well-known/agent-card.json`)
    console.log(`[agent] server view: http://localhost:${PORT}/`)
  })
}
```

- [ ] **Step 7: Typecheck, all tests, format, commit**

```bash
yarn typecheck
yarn test
yarn prettier --check src/agent/server-view.ts src/agent/__tests__/server-view.test.ts src/agent/index.ts src/agent/public/index.html
git add src/agent/server-view.ts src/agent/__tests__/server-view.test.ts src/agent/index.ts src/agent/public/index.html
git -c core.safecrlf=false commit -m "feat(agent): /health and a read-only API on the A2A port

Same process, same port, no new env var: the view is mounted before the A2A router so GET / is
the page and POST / is still JSON-RPC. The one action, Forget authorizations, exists for the
revocation demo on a reused context.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The page — `src/agent/public/index.html`, `agent.js`, a CSS block

**Files:**

- Modify: `src/agent/public/index.html` (replace the placeholder)
- Create: `src/agent/public/agent.js`
- Modify: `src/web/public/app.css` (append a block before `/* ---------- small screens ---------- */`)

**Interfaces:**

- Consumes: the API of Task 5; `window.ui` from `src/web/public/ui.js` (`el`, `escapeHtml`, `formatWhen`, `renderEvidence`).

- [ ] **Step 1: The markup**

Replace `src/agent/public/index.html` with:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Acme Invoice Agent — server view</title>
    <link rel="stylesheet" href="./shared/app.css" />
  </head>
  <body>
    <header>
      <div class="brand">
        <h1>Acme Invoice Agent <span class="role-chip">Server</span></h1>
        <p class="subtitle">The agent's own view: what it was asked, what it verified, what it refused</p>
      </div>
      <div class="channel">
        <span class="badge" id="channel-chip">Heka notifications: connecting…</span>
      </div>
      <nav>
        <button class="tab active" data-view="overview">Overview</button>
        <button class="tab" data-view="tasks">Tasks</button>
        <button class="tab" data-view="authorizations">Authorizations</button>
        <button class="tab" data-view="events">Events</button>
      </nav>
    </header>

    <main>
      <p class="failure" id="load-error" hidden></p>

      <section id="overview" class="view active">
        <h2>Overview</h2>
        <p class="note">
          What this process recorded about itself — read-only, except <strong>Forget authorizations</strong> on the
          Authorizations tab. The holder's and the client's actions live in the Trust Lens; its audit is separate from
          this journal.
        </p>
        <div class="counters" id="counters"></div>

        <div class="panel">
          <h3>Identity</h3>
          <div class="kv" id="identity-kv"></div>
        </div>

        <div class="panel">
          <h3>Trust</h3>
          <div class="kv" id="trust-kv"></div>
        </div>

        <div class="panel">
          <h3>Agent card</h3>
          <p class="note" id="card-note"></p>
          <pre class="raw" id="card-json"></pre>
        </div>
      </section>

      <section id="tasks" class="view">
        <h2>Tasks</h2>
        <p class="note">Every task this agent ran, newest first, with each status update it published.</p>
        <div id="task-list" class="cards"></div>
      </section>

      <section id="authorizations" class="view">
        <h2>Authorizations</h2>
        <p class="note">
          One record per verifier session this agent opened. The AS's sessions on the shared Heka tenant are not here:
          the agent drops every notification for a session it did not create.
        </p>
        <div class="forget">
          <button class="danger" id="forget">Forget authorizations</button>
          <span id="forget-confirm" hidden>
            <span class="note" id="forget-question"></span>
            <button class="danger" id="forget-yes">Yes, forget</button>
            <button id="forget-no">Keep</button>
          </span>
          <span class="note" id="forget-note"></span>
        </div>
        <div id="authorization-list" class="cards"></div>
      </section>

      <section id="events" class="view">
        <h2>Events</h2>
        <p class="note">The journal, newest first. Filter by type; the list grows as the agent works.</p>
        <div class="filters" id="event-filters"></div>
        <ol id="event-list" class="timeline"></ol>
      </section>
    </main>

    <script src="./shared/ui.js"></script>
    <script src="./agent.js"></script>
  </body>
</html>
```

- [ ] **Step 2: The script**

Create `src/agent/public/agent.js`:

```js
/* Acme Invoice Agent — server view: the relying party's own record, polled every 2 s while visible. */

const { el, escapeHtml, formatWhen } = ui

const POLL_MS = 2000
/** The agent's timeout denial; shown as Expired rather than Denied, as the Trust Lens does. */
const NO_PRESENTATION_IN_TIME = 'no presentation was received in time'
const STEPS = ['Requested', 'Wallet fetched', 'Verified', 'Status checked', 'Authorized']
const EVENT_TYPES = [
  'task.state',
  'auth.requested',
  'session.state',
  'auth.verified',
  'status.checked',
  'auth.authorized',
  'auth.denied',
  'channel.open',
  'channel.closed',
  'llm.fallback',
  'authorizations.cleared',
]

let view = 'overview'
let poller = null
/** Last rendered payloads, so a quiet tick does not rebuild the DOM under a text selection. */
const signatures = {}
/** The journal as the page knows it, newest first, grown with `since` polls. */
let events = []
let eventFilter = ''
let contexts = 0

const shorten = (value, head = 8) => (value && value.length > head + 4 ? `${value.slice(0, head)}…` : (value ?? ''))
const code = (value) => `<code title="${escapeHtml(value ?? '')}">${escapeHtml(value ?? '')}</code>`
const mmss = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

async function getJson(path) {
  const response = await fetch(path)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
  return data
}

/** Render only when the data changed. */
function changed(key, data) {
  const signature = JSON.stringify(data)
  if (signatures[key] === signature) return false
  signatures[key] = signature
  return true
}

// ---------- header ----------

function renderChannel(channel) {
  const chip = el('channel-chip')
  const label = { open: 'open', closed: 'reconnecting…', connecting: 'connecting…' }[channel.state] ?? channel.state
  chip.className = `badge ${channel.state === 'open' ? 'ok' : 'warn'}`
  chip.textContent = `Heka notifications: ${label}${channel.reconnects ? ` · ${channel.reconnects} reconnect${channel.reconnects === 1 ? '' : 's'}` : ''}`
  chip.title = `${channel.state} since ${formatWhen(channel.since)}${channel.lastError ? ` · last error: ${channel.lastError}` : ''}`
}

// ---------- overview ----------

const kv = (rows) =>
  rows
    .filter(Boolean)
    .map(([label, html]) => `<div><span>${escapeHtml(label)}</span><span>${html}</span></div>`)
    .join('')

function renderOverview(state) {
  contexts = state.counts.contexts
  if (!changed('overview', state)) return
  const { agent, trust, counts } = state

  el('counters').innerHTML = [
    ['Tasks', counts.tasks],
    ['Authorized', counts.authorized],
    ['Denied', counts.denied],
    ['Authorized contexts', counts.contexts],
  ]
    .map(([label, value]) => `<div class="counter"><strong>${value}</strong><span>${escapeHtml(label)}</span></div>`)
    .join('')

  el('identity-kv').innerHTML = kv([
    ['Agent', escapeHtml(agent.name)],
    ['Verifier DID', code(agent.verifierDid ?? '(not initialised)')],
    ['Resource DID', agent.resourceDid ? code(agent.resourceDid) : '<span class="note">not seeded</span>'],
    ['Public URL', code(agent.publicUrl)],
    ['Port', escapeHtml(String(agent.port))],
    ['Authorization timeout', `${escapeHtml(String(agent.authorizationTimeoutMs / 1000))} s`],
    ['LLM', agent.llm.enabled ? `on · ${escapeHtml(agent.llm.model ?? '')}` : 'off · deterministic report'],
    ['Started', escapeHtml(formatWhen(state.startedAt))],
  ])

  el('trust-kv').innerHTML = kv([
    [
      'Trusted issuer',
      trust.trustedIssuer ? code(trust.trustedIssuer) : '<span class="text-bad">none — run yarn seed</span>',
    ],
    ['Status lists', code(trust.statusListOrigin)],
    ['Verifier', 'Heka checks the signature and the key binding; this agent checks issuer, type, role and revocation'],
  ])
}

function renderCard(card) {
  if (!changed('card', card)) return
  el('card-note').innerHTML = `${escapeHtml(card.note)} Static card: ${code(card.staticCardUrl)}`
  el('card-json').textContent = JSON.stringify(card.live, null, 2)
}

async function loadOverview() {
  const [state, card] = await Promise.all([getJson('/api/state'), getJson('/api/card')])
  renderChannel(state.channel)
  renderOverview(state)
  renderCard(card)
}

// ---------- tasks ----------

const TASK_TONE = { completed: 'ok', failed: 'bad', canceled: 'bad', 'auth-required': 'warn' }

function taskCard(task) {
  const steps = task.steps
    .map(
      (step) => `<li class="${TASK_TONE[step.state] ?? ''}">
        <div class="when">${escapeHtml(formatWhen(step.at))} · ${escapeHtml(step.state)}</div>
        ${step.text ? escapeHtml(step.text) : ''}
      </li>`
    )
    .join('')
  const outcome = task.result
    ? `<pre class="raw">${escapeHtml(task.result)}</pre>`
    : task.error
      ? `<p class="refusal">${escapeHtml(task.error)}</p>`
      : ''
  return `
    <article class="card ${task.state === 'failed' || task.state === 'canceled' ? 'refused' : ''}">
      <div>
        <h3>Task ${escapeHtml(shorten(task.id))}</h3>
        <div class="meta">
          <span>context ${code(task.contextId)}</span>
          ${task.sessionId ? `<span class="chip">session ${escapeHtml(shorten(task.sessionId))}</span>` : ''}
          <span>started ${escapeHtml(formatWhen(task.startedAt))}</span>
        </div>
      </div>
      <div class="right"><span class="badge ${TASK_TONE[task.state] ?? ''}">${escapeHtml(task.state)}</span></div>
      <ol class="timeline">${steps}</ol>
      ${outcome}
    </article>`
}

async function loadTasks() {
  const data = await getJson('/api/tasks')
  if (!changed('tasks', data)) return
  el('task-list').innerHTML =
    data.tasks.map(taskCard).join('') || '<p class="empty">No task yet — engage the agent from the Trust Lens.</p>'
}

// ---------- authorizations ----------

/** How many steps are done; a denial after a status check has walked the whole strip. */
function stepProgress(record) {
  if (record.outcome === 'authorized') return 5
  if (record.outcome === 'denied') return record.status ? 4 : record.presentation ? 3 : 1
  return { RequestUriRetrieved: 2, ResponseVerified: 3 }[record.sessionState] ?? 1
}

function renderSteps(record) {
  const progress = stepProgress(record)
  const failed = record.outcome === 'denied'
  return STEPS.map((label, index) => {
    if (index === STEPS.length - 1 && failed) {
      return `<li class="bad">${record.reason === NO_PRESENTATION_IN_TIME ? 'Expired' : 'Denied'}</li>`
    }
    const cls = index < progress ? 'done' : index === progress ? 'current' : ''
    return `<li class="${cls}">${escapeHtml(label)}</li>`
  }).join('')
}

function countdown(record) {
  if (record.outcome) return ''
  const left = Math.max(0, Math.round((Date.parse(record.expiresAt) - Date.now()) / 1000))
  return `<p class="countdown ${left <= 30 ? 'bad' : ''}">${
    left > 0 ? `Agent timeout in ${mmss(left)}` : 'Agent timeout reached — denying on the next tick'
  }</p>`
}

function authorizationCard(record) {
  const denied = record.outcome === 'denied'
  const presentation = record.presentation
  const status = record.status
  const claims = Object.entries(presentation?.claims ?? {})
    .map(([name, value]) => `<span class="chip">${escapeHtml(name)} · ${escapeHtml(String(value))}</span>`)
    .join(' ')
  const statusText = status
    ? `${status.revoked ? 'revoked' : 'live'} · index ${status.statusListIndex} · checked ${formatWhen(status.checkedAt)}`
    : 'not checked'
  const badge = denied ? 'bad' : record.outcome ? 'ok' : 'warn'
  const label = record.outcome ? record.outcome.toUpperCase() : 'PENDING'

  return `
    <article class="card ${denied ? 'refused' : ''}">
      <div>
        <h3>Session ${escapeHtml(shorten(record.sessionId))} → task ${escapeHtml(shorten(record.taskId))}</h3>
        <div class="meta">
          <span>context ${code(record.contextId)}</span>
          <span>requested ${escapeHtml(formatWhen(record.requestedAt))}</span>
          <span class="chip">${escapeHtml(record.sessionState)}</span>
        </div>
      </div>
      <div class="right"><span class="badge ${badge}">${escapeHtml(label)}</span></div>
      <ol class="steps">${renderSteps(record)}</ol>
      ${countdown(record)}
      ${denied ? `<p class="refusal">${escapeHtml(record.reason ?? '')}</p>` : ''}
      <div class="kv compact">${kv([
        !denied && claims && ['Claims', claims],
        presentation?.credentialType && ['Credential', code(presentation.credentialType)],
        presentation?.issuer && ['Issuer', code(presentation.issuer)],
        presentation?.holder && ['Holder', code(presentation.holder)],
        [
          'Status',
          `<span class="${status?.revoked ? 'text-bad' : status ? 'text-ok' : ''}">${escapeHtml(statusText)}</span>`,
        ],
        record.verifiedAt && ['Verified', escapeHtml(formatWhen(record.verifiedAt))],
        record.decidedAt && ['Decided', escapeHtml(formatWhen(record.decidedAt))],
      ])}</div>
    </article>`
}

async function loadAuthorizations() {
  const [data, state] = await Promise.all([getJson('/api/authorizations'), getJson('/api/state')])
  renderChannel(state.channel)
  contexts = state.counts.contexts
  el('forget').disabled = contexts === 0 && el('forget-confirm').hidden
  el('forget').title = contexts === 0 ? 'No authorized context to forget' : ''
  // The countdown changes every tick, so the signature deliberately excludes nothing: rebuild each poll.
  el('authorization-list').innerHTML =
    data.authorizations.map(authorizationCard).join('') || '<p class="empty">No authorization requested yet.</p>'
}

async function forget() {
  el('forget-confirm').hidden = true
  el('forget').disabled = true
  try {
    const response = await fetch('/api/authorizations/forget', { method: 'POST' })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
    el('forget-note').textContent =
      `Forgot ${data.cleared} context${data.cleared === 1 ? '' : 's'} — the next task in each asks again.`
  } catch (error) {
    el('forget-note').textContent = `Could not forget: ${error.message}`
  } finally {
    el('forget').disabled = false
  }
  loadAuthorizations()
}

// ---------- events ----------

function renderFilters() {
  el('event-filters').innerHTML = ['', ...EVENT_TYPES]
    .map(
      (type) =>
        `<button class="chip ${type === eventFilter ? 'active' : ''}" data-type="${escapeHtml(type)}">${escapeHtml(type || 'all')}</button>`
    )
    .join('')
}

const EVENT_TONE = {
  'auth.authorized': 'ok',
  'channel.open': 'ok',
  'auth.denied': 'bad',
  'channel.closed': 'bad',
  'llm.fallback': 'bad',
}

function renderEvents() {
  const shown = eventFilter ? events.filter((event) => event.type === eventFilter) : events
  el('event-list').innerHTML =
    shown
      .map(
        (event) => `<li class="${EVENT_TONE[event.type] ?? ''}">
          <div class="when">${escapeHtml(formatWhen(event.at))} · ${escapeHtml(event.type)}${
            event.taskId ? ` · task ${escapeHtml(shorten(event.taskId))}` : ''
          }${event.sessionId ? ` · session ${escapeHtml(shorten(event.sessionId))}` : ''}</div>
          ${escapeHtml(event.text)}
          ${ui.renderEvidence(event.data)}
        </li>`
      )
      .join('') || '<li class="note">Nothing recorded yet.</li>'
}

async function loadEvents() {
  const since = events[0]?.id
  const data = await getJson(since ? `/api/events?since=${encodeURIComponent(since)}` : '/api/events')
  // An unknown `since` (the agent restarted) returns everything: start over rather than duplicate.
  if (since && data.events.some((event) => event.id === since)) events = []
  if (!data.events.length && since) return
  events = [...data.events, ...events]
  renderEvents()
}

// ---------- polling ----------

const LOADERS = { overview: loadOverview, tasks: loadTasks, authorizations: loadAuthorizations, events: loadEvents }

async function tick() {
  if (document.hidden) return
  try {
    await LOADERS[view]()
    // Every view keeps the header honest, not just the overview.
    if (view !== 'overview' && view !== 'authorizations') renderChannel((await getJson('/health')).channel)
    el('load-error').hidden = true
  } catch (error) {
    el('load-error').hidden = false
    el('load-error').textContent = `Could not read the agent: ${error.message}`
  }
}

function showView(name) {
  view = name
  document.querySelectorAll('.view').forEach((section) => section.classList.toggle('active', section.id === name))
  document
    .querySelectorAll('.tab[data-view]')
    .forEach((tab) => tab.classList.toggle('active', tab.dataset.view === name))
  clearInterval(poller)
  tick()
  poller = setInterval(tick, POLL_MS)
}

// ---------- wiring ----------

document
  .querySelectorAll('.tab[data-view]')
  .forEach((tab) => tab.addEventListener('click', () => showView(tab.dataset.view)))

el('forget').addEventListener('click', () => {
  el('forget-note').textContent = ''
  el('forget-question').textContent =
    `Clears ${contexts} authorized context${contexts === 1 ? '' : 's'}; the next task in those contexts will ask again.`
  el('forget-confirm').hidden = false
})
el('forget-yes').addEventListener('click', forget)
el('forget-no').addEventListener('click', () => {
  el('forget-confirm').hidden = true
})

el('event-filters').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-type]')
  if (!chip) return
  eventFilter = chip.dataset.type
  renderFilters()
  renderEvents()
})

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) tick()
})

renderFilters()
showView('overview')
```

- [ ] **Step 3: The CSS block**

In `src/web/public/app.css`, insert before `/* ---------- small screens ---------- */`:

```css
/* ---------- agent server view ---------- */

.counters {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 20px;
}

.counter {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 10px 16px;
  min-width: 120px;
}

.counter strong {
  display: block;
  font-size: 22px;
  line-height: 1.2;
}

.counter span {
  color: var(--muted);
  font-size: 12px;
}

/* Filter chips are buttons that look like chips; the button rule above would give them button padding. */
.filters {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 14px;
}

.filters .chip {
  background: transparent;
  color: var(--muted);
  border-radius: 999px;
  padding: 3px 11px;
  font-size: 12px;
}

.filters .chip.active {
  color: var(--text);
  border-color: var(--accent);
}

/* The one action on the page, with its inline confirmation. */
.forget {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 14px;
}

.forget .note {
  margin: 0;
}

/* A task's steps and an authorization's strip sit under the card's title row. */
.card > .timeline,
.card > .steps,
.card > .countdown,
.card > pre.raw {
  grid-column: 1 / -1;
}

.card > .timeline {
  margin-top: 4px;
  gap: 6px;
}

.card > .timeline li {
  padding: 6px 12px;
  font-size: 12.5px;
}

.card > .steps {
  margin-top: 4px;
}

.card > .countdown {
  margin-top: 0;
}

.card > pre.raw {
  margin: 4px 0 0;
}

.card > .kv.compact {
  grid-column: 1 / -1;
  margin-top: 4px;
}
```

- [ ] **Step 4: Static checks**

```bash
node --check src/agent/public/agent.js
yarn prettier --check src/agent/public/index.html src/agent/public/agent.js src/web/public/app.css
yarn test
```

Expected: no syntax error; prettier clean (run `yarn prettier --write` on the three files if not, then re-check); tests pass (the server-view test still finds `Acme Invoice Agent` in the page).

- [ ] **Step 5: Look at it (static, against the test server)**

A temporary look without the operator's agent: `yarn tsx -e` is not needed — the Task 8 stack does this properly. Skip to commit; the visual pass is Task 8 step 3.

- [ ] **Step 6: Commit**

```bash
git add src/agent/public/index.html src/agent/public/agent.js src/web/public/app.css
git -c core.safecrlf=false commit -m "feat(agent): the server view page — overview, tasks, authorizations, events

Vanilla JS on the Trust Lens's ui.js and app.css through /shared, polling every 2 s while
visible. Authorizations walk the same step strip the Trust Lens shows, from the agent's side; the
Events tab grows with \`since\`. One action: Forget authorizations, with an inline confirmation.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Docs, skills and the brief's step 7

**Files:**

- Modify: `README.md` (components table row 591; "Open the demo" 416–428; Path A line 289; Path B agent `docker run` note 367)
- Modify: `docs/OPERATIONS.md:12`
- Modify: `docs/ARCHITECTURE.md` (component diagram note near line 32; layout line 140)
- Modify: `.claude/skills/run-demo/SKILL.md:141-147`
- Modify: `.claude/skills/troubleshoot/SKILL.md` (a new entry after `no presentation was received in time`, line 76; "When nothing matches" line 184)
- Modify: `docs/tasks/04-agent-server-view.md` (Steps to validate, step 7)

- [ ] **Step 1: README**

"Open the demo" (line 418): change the sentence to

```markdown
Both paths land here. Open **http://localhost:4000** (Trust Lens), **http://localhost:4100** (TrustCo Console) and **http://localhost:10003** (the agent's server view — read-only, the relying party's own record).
```

Port table row (line 428):

```markdown
| Acme Invoice Agent | 10003 (A2A + server view) |
```

After step 3 of the walkthrough (the paragraph ending "…a pending task keeps running while you look elsewhere.", line 434), add a paragraph:

```markdown
The same engagement seen from the other side: **http://localhost:10003** is the agent's server view — its identity (verifier `did:key`, resource `did:hedera`), the live agent card next to the digest-pinned one, every task with its status updates, every authorization with the session's progress, the status check and the decision, and a journal. **Forget authorizations** there clears the agent's memory of authorized contexts, so a reused context asks again — which is how to show a revocation biting a context that was authorized before it.
```

Path A, line 289: `yarn agent      # Acme Invoice Agent, A2A + OID4VP In-Task Auth, server view on the same port`.

Path B, after the `trustlens-agent` `docker run` block (around line 369), add: `The agent's server view rides on the same port: http://localhost:10003/.`

Components table (line 591): `| Acme Invoice Agent   | \`src/agent\` | A2A agent with OID4VP In-Task Auth; its server view (journal, tasks, authorizations) on the same port |` — keep the column widths aligned with the rows around it.

- [ ] **Step 2: OPERATIONS**

Line 12: `| Acme Invoice Agent    | 10003 (A2A + server view) | A2A path                |`. Re-align the table if the column grew (prettier does not touch tables; align by hand).

- [ ] **Step 3: ARCHITECTURE**

Near the component diagram (line 32 area), after the diagram, add one sentence: `The agent serves its own read-only page on the A2A port (`src/agent/server-view.ts`, `src/agent/public/`): a journal (`src/agent/journal.ts`) and a state index (`src/agent/state.ts`) fed by the executor.` Layout (line 140): `agent/        Acme Invoice Agent (A2A + In-Task Auth); journal.ts, state.ts and server-view.ts + public/ for its server view`.

- [ ] **Step 4: Skills**

`run-demo` "Confirm it is actually up" (line 143 block):

```bash
curl -s "http://localhost:4000/api/discovery?q=Acme%20invoice"   # 3 results
curl -s http://localhost:4100/api/credentials                    # 3 credential tiles
curl -s http://localhost:4000/api/mcp/tools                      # 2 tools
curl -s http://localhost:10003/health                            # {"ok":true,…,"channel":{"state":"open",…}}
```

`troubleshoot`: after the `no presentation was received in time` entry (line 76), add:

```markdown
### Did the wallet fetch the request at all?

The agent's server view answers without reading its terminal: `http://localhost:10003/`, Events
tab — `session RequestUriRetrieved` means the wallet fetched the request, `auth.verified` that
Heka accepted the presentation, `status.checked` what the agent read from the status list. No
`session.state` at all means the request never reached a wallet (or the notification channel is
down: the header badge says `reconnecting…` and `/health` shows `channel.state`).
```

"When nothing matches" (line 184 item 1) — append: `The agent's side is also on its page: http://localhost:10003/ (Events).`

- [ ] **Step 5: The brief's step 7**

In `docs/tasks/04-agent-server-view.md`, replace the step 7 curl and its expectation with:

````markdown
7. **Forget authorizations** — take `contextId` from step 3's task. Send a second message in
   that context straight to the agent, non-blocking (a blocking `message/send` waits for a final
   state, and `auth-required` is deliberately not final — the Trust Lens stream must survive the pause):

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
````

Also, in the brief's "Findings" list, no edit — findings are dated; the DoD line "clears `authorizedContexts` and `verifiedSessions`" becomes "clears `authorizedContexts` (and prunes the decided sessions' state)".

- [ ] **Step 6: Check and commit**

```bash
yarn prettier --check README.md docs/OPERATIONS.md docs/ARCHITECTURE.md docs/tasks/04-agent-server-view.md .claude/skills/run-demo/SKILL.md .claude/skills/troubleshoot/SKILL.md
git add README.md docs/OPERATIONS.md docs/ARCHITECTURE.md docs/tasks/04-agent-server-view.md .claude/skills/run-demo/SKILL.md .claude/skills/troubleshoot/SKILL.md
git -c core.safecrlf=false commit -m "docs: the agent's server view rides on port 10003

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Live validation on a second stack

**Files:** none (validation only; findings become fix commits).

The operator's stack (4000 / 10003 / 4300 / 4400) stays untouched. Start, from `demo/trust-lens`, in two background terminals:

```bash
ACME_AGENT_PORT=10004 ACME_AGENT_PUBLIC_URL=http://localhost:10004/ yarn agent
```

```bash
TRUST_LENS_WEB_PORT=4001 TRUST_LENS_DIDCOMM_PORT=4011 ACME_AGENT_URL=http://localhost:10004 yarn web
```

- [ ] **Step 1: Health and identity (brief step 1)**

```bash
curl -s http://localhost:10004/health
curl -s http://localhost:10004/api/state | jq '.agent, .trust, .counts'
```

Expect `ok: true`, `channel.state: "open"`, `resourceDid` = `.seed-state.json` `dids.acmeAgent`, `trustedIssuer` = `issuerDid`, `llm.enabled` matching `OPENAI_API_KEY`.

- [ ] **Step 2: A2A untouched (brief step 2)**

```bash
curl -s http://localhost:10004/.well-known/agent-card.json | jq .name
yarn verify:live
```

Expect `"Acme Invoice Agent"` and `RESULT: PASS — the lookalike is refused, the genuine agent is usable`.

- [ ] **Step 3: A task as it happens, decided on the page (brief steps 3–4)**

Open `http://localhost:10004/` in the browser pane. `curl -s -X POST http://localhost:4001/api/engage -H 'content-type: application/json' -d '{"identifier":"<acme agent identifier from /api/discovery>"}'` (or press Engage in `http://localhost:4001`), then `curl -s -X POST http://localhost:4001/api/task/<id>/simulate-presentation`. Check: Tasks tab shows `submitted → working → working → auth-required → working (×2) → completed`; Authorizations card walks to Authorized with `role · org`, issuer, holder, `index 3 · live`; Events has `auth.verified`, `status.checked`, `auth.authorized` with one `sessionId`; `/api/tasks` id/contextId equal `a2a.taskId`/`a2a.contextId` from `GET :4001/api/task/<id>`.

- [ ] **Step 4: A denial (brief step 5)**

Revoke the officer credential via the console API (`curl -s -X POST http://localhost:4100/api/credentials/officer/status -H 'content-type: application/json' -d '{"revoked":true}'`), engage + simulate on 4001, check the red card and `auth.denied` first in `/api/events`, then restore (`{"revoked":false}`).

- [ ] **Step 5: Only the agent's sessions (brief step 6)**

On `http://localhost:4001` MCP tab, invoke the sensitive tool and simulate (or `POST /api/mcp/call` + `POST /api/mcp/simulate-presentation`). The agent's Authorizations and Events gain nothing.

- [ ] **Step 6: Forget authorizations (rewritten brief step 7)** — as written in Task 7 step 5, against 10004.

- [ ] **Step 7: Cancel hits the right task (brief step 9)**

Engage on 4001; while `auth-required`, `tasks/cancel` with the `a2a.taskId` on 10004. Expect the JSON-RPC result with `status.state: "canceled"`, the Tasks tab showing `canceled` as the last step, and nothing after it within the next 10 s.

- [ ] **Step 8: Channel health (brief step 8) — only with the operator's explicit yes.** Otherwise record as "not run" in the summary.

- [ ] **Step 9: Stop the second stack**, fix anything found (one commit per fix), rerun `yarn typecheck && yarn test`.

---

## Self-review

- Brief scope 1 (journal, state) → Tasks 1–2. Scope 2 (API, page) → Tasks 5–6. Scope 3 (task id, session filtering, `/health`) → Task 4 (`context.taskId`, `noteSessionState`; the filter itself exists since T3) and Task 5 (`/health`). Scope 4 (Forget) → Tasks 2, 4, 5, 6. Scope 5 (docs, skills) → Task 7. Every DoD line has a task; validation → Task 8.
- Names used across tasks: `AgentState.taskStep / authorizationRequested / sessionState / statusChecked / authorizationDecided / channelState / channelError / llmFallback / forgetAuthorizations / isDecided / listTasks / listAuthorizations / counts` — consistent between Task 2 (definition), Task 4 (executor), Task 5 (API) and the tests. `prepareInvoiceReport(prompt, onFallback)`, `llmEnabled`, `LLM_MODEL` — Task 3 → Tasks 4–5. `mountServerView(app, { state, startedAt, identity, trust, card, staticCardUrl, forgetAuthorizations })` — Task 5 definition, test and `main` agree.
- `counts` returns `{ tasks, authorized, denied, contexts }` — a superset of the brief's `{ tasks, authorized, denied }`; the page uses `contexts` for the Forget confirmation.
