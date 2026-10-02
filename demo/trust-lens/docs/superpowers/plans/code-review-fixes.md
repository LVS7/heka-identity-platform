# Code review fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the High and Medium findings (and the cheap Low ones) of the second code review of `main...litvinov-demo`, so the stand no longer ends up in a quiet wrong state that only a restart or a New chat clears.

**Architecture:** Fixes stay inside the existing modules. Two entry files are split so their logic can be imported by tests (`src/mcp/auth-server.ts` → `authorization-server.ts`, `src/agent/index.ts` → `executor.ts`). Infrastructure failures become `engagement_refused / UNAVAILABLE` in the audit and never end a step-up as a human denial. Seed state is read per decision, so `yarn seed --reset` needs no restarts. The browser gets one `api()` helper and per-action busy flags.

**Tech Stack:** TypeScript (strict, `tsx`), Express 5, `@modelcontextprotocol/sdk` 1.x, `@a2a-js/sdk` 0.3, Credo 0.7 (pinned), Genkit + compat-oai, vitest, vanilla JS UI.

**Source of the findings:** the second review — `C:\Users\vadim\WebstormProjects\DS\reviews\litvinov-demo-code-review-2-2026-10-01.md` (outside the repo, in Russian). Finding numbers below (`6.1`, `9.4` …) refer to it; `prev #N` refers to the first review in the same folder.

## Global Constraints

- Branch `code-review-fixes`, created from `task/06-mcp-chat-authorization` (`175ecd7`). Nothing is pushed.
- English throughout — code, comments, docs, commit messages. Comments explain *why*.
- `src/core` stays dependency-light (Node built-ins only).
- Credo stays pinned at `0.7.0`; no dependency is added.
- No `// @ts-expect-error`, no `as any`.
- The seven invariants in `CLAUDE.md` hold. A refusal is audited; fail closed.
- Audit vocabulary (decision Q3): an infrastructure failure is `engagement_refused` with outcome `UNAVAILABLE`; `denial` is reserved for a decision about a presented credential. A 401/403 challenge is `authorization` / `step-up required` (Q4).
- One commit per task, message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- After every task: `yarn typecheck` and `yarn test` pass (run from `demo/trust-lens`).

## Out of scope (decided in Q1)

Splitting `app.js` into ES modules (second half of 3.3); parallel DID creation in `seed.ts` (4.10, writes to Hedera testnet); unifying the two agent-card builders (3.4); a guard for a second `message/send` to a running task (6.8 — the SDK's bus-sharing behaviour would have to be verified first; external clients only); first-review items the second review does not build on (prev #1, #3, #4, #10–#12). Low items left as they are: restoring a pending MCP step-up after a page reload (9.8), one audit subject per resource (3.6), a single owner of session state in the agent (3.8), a waiter instead of the agent's 500 ms poll (4.6), caching `.seed-state.json` reads (4.7 — per-request reads are now what makes a reseed work), unread response fields and `AuditLog.list({ limit })` (1.2, 1.4), the `SimulatedHolder` extraction (3.5).

## File structure

| File | Change |
| --- | --- |
| `src/mcp/authorization-server.ts` | **new** — `AuthorizationServer` + `createAuthorizationApp()`, moved out of `auth-server.ts` |
| `src/mcp/auth-server.ts` | entry only: env, `main()`, listen |
| `src/agent/executor.ts` | **new** — `InvoiceAgentExecutor`, `agentCard()`, errors, moved out of `index.ts` |
| `src/agent/index.ts` | entry only |
| `src/shared/retry.ts` | **new** — `retryUntil()` |
| `src/shared/listen.ts` | **new** — `listenOrExit()` for every Express service |
| `src/shared/presented-credential.ts` | + `evaluateOfficerPresentation()`, `officerPresentationDefinition()` |
| `src/web/chat.ts`, `mcp-client.ts`, `mcp-path.ts`, `oauth-provider.ts`, `server.ts`, `tasks.ts` | step-up outcomes, rollback, discovery, timeouts |
| `src/web/public/app.js`, `index.html` | `api()` helper, busy flags, unavailable notes, Run again |
| `src/shared/simulated-wallet.ts`, `src/seed/state.ts`, `src/console/server.ts` | seed-reset awareness, atomic write |
| `src/shared/identity-service.ts`, `src/agent/invoice-work.ts`, `src/agent/state.ts` | timeouts, backoff, lifecycle |
| `src/shared/wallet-link-credo.ts` | inbound transport removed |
| tests | `src/mcp/__tests__/authorization-server.test.ts` (new), `src/shared/__tests__/retry.test.ts` (new), `src/seed/__tests__/state.test.ts` (new), additions to `chat.test.ts`, `mcp-client.test.ts`, `agent/__tests__/state.test.ts` |

---

### Task 1: Make the authorization server and the agent executor importable

No behaviour change. Both modules run `main()` on import today, so nothing in them is tested (review §6, 9; prev #3).

**Files:**
- Create: `src/mcp/authorization-server.ts`, `src/agent/executor.ts`, `src/mcp/__tests__/authorization-server.test.ts`
- Modify: `src/mcp/auth-server.ts`, `src/agent/index.ts`

**Interfaces:**
- Produces: `class AuthorizationServer(identityService, options: { issuer: string; tokenTtlSeconds: number })`, `createAuthorizationApp(as: AuthorizationServer): express.Express`, `SUPPLIERS_EXPORT_SCOPE`, `type AuthorizationPoll`; `class InvoiceAgentExecutor(identityService, state, options: { authorizationTimeoutMs: number })`, `agentCard(publicUrl: string): AgentCard`.

- [ ] **Step 1: Move the AS.** Cut everything in `auth-server.ts` from `export const SUPPLIERS_EXPORT_SCOPE` to the end of `class AuthorizationServer` into `authorization-server.ts`; export the class. Replace the module constants `ISSUER` and `TOKEN_TTL_SECONDS` with constructor options:

```ts
export interface AuthorizationServerOptions {
  issuer: string
  /** Short by design: a revoked credential must stop mattering within minutes, not hours. */
  tokenTtlSeconds: number
}

export class AuthorizationServer {
  // …fields unchanged…
  public constructor(
    private readonly identityService: IdentityServiceClient,
    private readonly options: AuthorizationServerOptions
  ) {}
```

and use `this.options.issuer` / `this.options.tokenTtlSeconds` where the constants were. Move the route definitions from `main()` into:

```ts
/** The AS's HTTP surface; `main()` in auth-server.ts only adds the environment and listens. */
export function createAuthorizationApp(as: AuthorizationServer): express.Express {
  const app = express()
  app.use(express.json())
  app.use(express.urlencoded({ extended: true }))
  // …the five routes, verbatim…
  return app
}
```

`auth-server.ts` keeps the file comment, `dotenv.config()`, `PORT`, `ISSUER`, `TOKEN_TTL_SECONDS` and:

```ts
async function main() {
  const as = new AuthorizationServer(identityServiceFromEnv(), { issuer: ISSUER, tokenTtlSeconds: TOKEN_TTL_SECONDS })
  await as.initialize()
  createAuthorizationApp(as).listen(PORT, () => { /* the two existing log lines */ })
}
```

- [ ] **Step 2: Move the executor.** Cut `OFFICER_PRESENTATION_DEFINITION` … `collectText` from `agent/index.ts` into `agent/executor.ts`; export `InvoiceAgentExecutor`, `agentCard`, `AuthorizationDenied`, `TaskCancelled`. `agentCard()` takes `publicUrl: string`; the executor takes `{ authorizationTimeoutMs }` and uses it where `AUTHORIZATION_TIMEOUT_MS` was. `index.ts` keeps env constants and `main()`, passing `agentCard(PUBLIC_URL)` and `{ authorizationTimeoutMs: AUTHORIZATION_TIMEOUT_MS }`.

- [ ] **Step 3: Smoke test for the AS app.**

```ts
// src/mcp/__tests__/authorization-server.test.ts
import { describe, expect, it } from 'vitest'
import request from './http'   // see below — a 15-line helper, no new dependency
import { AuthorizationServer, createAuthorizationApp } from '../authorization-server'
import { IdentityServiceClient } from '../../shared/identity-service'

/** Heka as far as the AS uses it; each test scripts what it needs. */
function fakeHeka(overrides: Partial<IdentityServiceClient> = {}): IdentityServiceClient {
  return {
    baseOrigin: 'http://heka',
    prepareWallet: async () => 'did:key:verifier',
    createVerificationSession: async () => ({
      verificationSession: { id: 'sess-1', state: 'RequestCreated' },
      authorizationRequest: 'openid4vp://?request_uri=x',
    }),
    getVerificationSession: async () => ({ id: 'sess-1', state: 'RequestCreated' }),
    ...overrides,
  } as unknown as IdentityServiceClient
}

async function app(heka = fakeHeka()) {
  const as = new AuthorizationServer(heka, { issuer: 'http://as', tokenTtlSeconds: 300 })
  await as.initialize()
  return createAuthorizationApp(as)
}

const AUTHORIZE = '/authorize?client_id=c&redirect_uri=http%3A%2F%2Fclient%2Fcb&code_challenge=abc&code_challenge_method=S256&scope=suppliers%3Aexport&resource=http%3A%2F%2Fmcp%2Fmcp'

describe('authorization server', () => {
  it('serves RFC 8414 metadata for its issuer', async () => {
    const res = await request(await app(), 'GET', '/.well-known/oauth-authorization-server')
    expect(res.status).toBe(200)
    expect(res.body.token_endpoint).toBe('http://as/token')
  })

  it('requires PKCE with S256', async () => {
    const res = await request(await app(), 'GET', '/authorize?redirect_uri=x&resource=y')
    expect(res.status).toBe(400)
  })

  it('answers pending while the wallet has not presented', async () => {
    const a = await app()
    const begun = await request(a, 'GET', AUTHORIZE)
    const poll = await request(a, 'GET', `/authorize/${begun.body.requestId}`)
    expect(poll.body).toMatchObject({ status: 'pending', session: { id: 'sess-1' } })
  })
})
```

`src/mcp/__tests__/http.ts` (test helper, listens on port 0 and uses global `fetch` — the pattern `mcp-client.test.ts` already uses):

```ts
import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import express from 'express'

export default async function request(app: express.Express, method: string, path: string, body?: unknown) {
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : undefined }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}
```

- [ ] **Step 4:** `yarn typecheck && yarn test` → green (new file: 3 passed). `yarn as` and `yarn agent` still start (checked in Task 13).
- [ ] **Step 5: Commit** `refactor(trust-lens): the AS and the agent executor are importable` — body: why (untested lifecycle paths), no behaviour change.

---

### Task 2: A failed tool turn no longer breaks the chat (6.1, 6.11, 2.4)

**Files:** Modify `src/web/chat.ts`; Test `src/web/__tests__/chat.test.ts`

**Interfaces:** Produces `ToolTurn.historyMark: number` (internal).

- [ ] **Step 1: Failing test** (append to `chat.test.ts`, reusing `fakeLlm`, `FakeTools`, `request`, `answer`, `session` helpers already there):

```ts
it('keeps the history valid after a tool call fails mid-turn, so the next message works', async () => {
  // invoices-list has no scripted outcome: FakeTools throws, as a dropped MCP connection does.
  const { llm, calls } = fakeLlm([request('invoices-list'), answer('Two invoices are held.')])
  const chat = session(llm, new FakeTools({}))

  chat.send('Which invoices are held?')
  await chat.running
  expect(chat.state).toBe('error')

  chat.send('Which invoices are held?')
  await chat.running
  expect(chat.state).toBe('idle')

  // The second request must not carry a model turn whose tool calls were never answered.
  const history = calls[1].messages
  const dangling = history.findIndex(
    (m, i) => m.role === 'model' && m.content.some((c) => 'toolRequest' in c) && history[i + 1]?.role !== 'tool'
  )
  expect(dangling).toBe(-1)
})

it('rolls back a turn that hit the tool-turn limit', async () => {
  const turns = Array.from({ length: MAX_TOOL_TURNS + 1 }, (_, i) => request('invoices-list', `r${i}`))
  const outcomes = { 'invoices-list': Array.from({ length: MAX_TOOL_TURNS }, () => ok(ROWS)) }
  const { llm, calls } = fakeLlm([...turns, answer('done')])
  const chat = session(llm, new FakeTools(outcomes))
  chat.send('loop')
  await chat.running
  expect(chat.state).toBe('error')
  chat.send('again')
  await chat.running
  const last = calls.at(-1)!.messages.at(-2)! // the message before the new user message
  expect(last.role).not.toBe('model')
})
```

(If `session(...)` in the test file has a different signature, call it the way the existing tests do.)

- [ ] **Step 2:** `yarn vitest run src/web/__tests__/chat.test.ts` → the two new tests FAIL (state stays `error`, dangling model turn).

- [ ] **Step 3: Implement.** In `chat.ts`:

```ts
interface ToolTurn {
  // …existing fields…
  /** Length of the history before the model's tool-request message: a failed turn is cut back to it. */
  historyMark: number
}
```

```ts
  /** The turn whose tool calls are not answered yet — the one a failure has to undo. */
  private openTurn?: ToolTurn
```

In `run()`:

```ts
        if (generation !== this.generation) return
        const historyMark = this.messages.length
        this.messages.push(reply.message)

        if (!reply.toolRequests.length) { /* unchanged */ }
        if (++toolTurns > MAX_TOOL_TURNS) {
          this.messages.length = historyMark
          this.fail('too many tool turns')
          return
        }
        turn = { tools, requests: reply.toolRequests, index: 0, responses: [], toolTurns, historyMark }
        this.openTurn = turn
```

In `runRequests()` after `this.messages.push({ role: 'tool', content: turn.responses })`: `this.openTurn = undefined`.

```ts
  /**
   * A model turn whose tool calls go unanswered makes every later request invalid (OpenAI answers
   * 400 until the history is cleared), so a failure cuts the history back to before that turn. The
   * person's question stays; the next message is asked against a consistent history.
   */
  private fail(message: string): void {
    if (this.openTurn) this.messages.length = this.openTurn.historyMark
    this.openTurn = undefined
    this.current = 'error'
    this.failure = message
    this.paused = undefined
  }
```

`reset()` also sets `this.openTurn = undefined`.

6.11 — in `resume()`, remove the `this.audit.record('denial', …)` call: the poll route that decided the step-up has already audited the decision with its presentation (Task 3 keeps that true for every outcome). Keep the step summary.

2.4 — file comment: replace "The model never retries on its own: a 401/403 pauses the loop and only resume() continues it." with "A 401/403 pauses the loop and only resume() continues it; after a denial the model may ask again, which `MAX_TOOL_TURNS` bounds."

- [ ] **Step 4:** chat tests → PASS; `yarn typecheck && yarn test` → green. If an existing test asserted the duplicate denial audit in `resume()`, change it to assert one denial record (from the poll route's side it is no longer the chat's job).
- [ ] **Step 5: Commit** `fix(trust-lens): a failed tool turn no longer breaks the chat` — body: OpenAI 400 on dangling tool calls, reproduced on the stand; rollback; single denial record.

---

### Task 3: A step-up ends only on a decision — outages are UNAVAILABLE (6.2, 9.5, 6.12, 6.13, 5.1, prev #9)

**Files:** Modify `src/mcp/authorization-server.ts`, `src/web/mcp-client.ts`, `src/web/oauth-provider.ts`, `src/web/mcp-path.ts`, `src/web/chat.ts`, `src/web/tasks.ts`, `src/agent/executor.ts`, `src/web/public/app.js`, `src/web/public/index.html`; Create `src/shared/retry.ts`; Tests `authorization-server.test.ts`, `mcp-client.test.ts`, `src/shared/__tests__/retry.test.ts`

**Interfaces:**
- Produces (AS): `AuthorizationPoll` gains `{ state: 'unavailable'; reason: string }` and `{ state: 'expired' }`; route answers `503 temporarily_unavailable`, `404` for unknown/expired, `403` only for a decision, `500 server_error` for anything else.
- Produces (client): `class AuthorizationUnavailableError extends Error`, `class AuthorizationLostError extends Error` in `mcp-client.ts`; `PendingAuthorization.unavailableAudited?: boolean`.
- Produces: `retryUntil<T>(fn: () => Promise<T>, deadline: number, delayMs?: number): Promise<T>` in `src/shared/retry.ts`.

- [ ] **Step 1: Failing tests.**

`authorization-server.test.ts`:

```ts
it('answers 503 and keeps the request when Heka cannot be read', async () => {
  let fail = true
  const a = await app(fakeHeka({
    getVerificationSession: async () => {
      if (fail) throw new Error('connect ECONNREFUSED')
      return { id: 'sess-1', state: 'RequestCreated' }
    },
  }))
  const begun = await request(a, 'GET', AUTHORIZE)
  const outage = await request(a, 'GET', `/authorize/${begun.body.requestId}`)
  expect(outage.status).toBe(503)
  expect(outage.body.error).toBe('temporarily_unavailable')
  fail = false
  const later = await request(a, 'GET', `/authorize/${begun.body.requestId}`)
  expect(later.body.status).toBe('pending')
})

it('rejects a redirect_uri that is not a URL before any session is created', async () => {
  let created = 0
  const a = await app(fakeHeka({ createVerificationSession: async () => { created++; throw new Error('unreachable') } }))
  const res = await request(a, 'GET', AUTHORIZE.replace('http%3A%2F%2Fclient%2Fcb', 'foo'))
  expect(res.status).toBe(400)
  expect(created).toBe(0)
})
```

(The redirect test belongs to Task 4; writing it now is fine — it fails until then. Mark it `it.todo` here if you prefer strict task order.)

`mcp-client.test.ts` — the file already has `fakeAs(polls)` with scripted `[status, body]` answers. Add:

```ts
it('keeps the step-up pending when the AS is unavailable', async () => {
  const { connection } = await stepUpWith([[503, { error: 'temporarily_unavailable', error_description: 'heka down' }]])
  await expect(connection.pollAuthorization()).rejects.toBeInstanceOf(AuthorizationUnavailableError)
  expect(connection.pending).toBeDefined()
})

it('ends the step-up without a denial when the AS no longer knows the request', async () => {
  const { connection } = await stepUpWith([[404, { error: 'invalid_request', error_description: 'unknown authorization request' }]])
  await expect(connection.pollAuthorization()).rejects.toBeInstanceOf(AuthorizationLostError)
  expect(connection.pending).toBeUndefined()
  expect(connection.lastDecision).toMatchObject({ granted: false })
})

it('labels a denial without a vp_token as unknown, not as a QR scan', async () => {
  const { connection } = await stepUpWith([[403, { error: 'access_denied', error_description: 'revoked', presentation: { sessionId: 's', outcome: 'denied', reason: 'revoked' } }]])
  await expect(connection.pollAuthorization()).rejects.toMatchObject({ presentation: { source: 'unknown' } })
})
```

where `stepUpWith(polls)` is the existing setup the file uses for its denial test (connect, call the scoped tool, get the 401 into a pending step-up) — extract it into a helper if it is inline today.

`src/shared/__tests__/retry.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { retryUntil } from '../retry'

describe('retryUntil', () => {
  it('returns the first success', async () => {
    let n = 0
    const value = await retryUntil(async () => { if (++n < 3) throw new Error('flaky'); return n }, Date.now() + 1000, 1)
    expect(value).toBe(3)
  })
  it('rethrows the last error once the deadline has passed', async () => {
    await expect(retryUntil(async () => { throw new Error('down') }, Date.now() + 20, 5)).rejects.toThrow('down')
  })
})
```

- [ ] **Step 2:** run the three files → new tests FAIL.

- [ ] **Step 3: AS.** In `authorization-server.ts`:

```ts
/** An abandoned request is forgotten after this; the verifier session behind it is long gone. */
const PENDING_TTL_MS = 10 * 60_000

export type AuthorizationPoll =
  | { state: 'pending'; session: { id: string; state: string } }
  | { state: 'granted'; /* unchanged */ }
  | { state: 'denied'; session?: { id: string; state: string }; reason: string; presentation?: InTaskOpenId4VpAuthorizationResult }
  | { state: 'unavailable'; reason: string }
  | { state: 'expired' }
```

`pollAuthorization` begins:

```ts
    const authorization = this.pending.get(requestId)
    if (!authorization) return { state: 'expired' }
    if (Date.now() - authorization.createdAt > PENDING_TTL_MS) {
      this.pending.delete(requestId)
      return { state: 'expired' }
    }

    const trustedIssuer = loadState().issuerDid
    if (!trustedIssuer) {
      // A missing trust anchor is a refusal by this relying party, not an outage.
      this.pending.delete(requestId)
      return { state: 'denied', reason: 'no trusted issuer configured — run `yarn seed`' }
    }

    let session: VerificationSessionRecord
    try {
      session = await this.identityService.getVerificationSession(authorization.verificationSessionId)
    } catch (error) {
      // Heka unreachable is not a decision about anyone's credential: the request stays open and the
      // client polls again. Only a refusal below ends it.
      return { state: 'unavailable', reason: (error as Error).message }
    }
```

(rest unchanged; the `status-unavailable` refusal from `assertPresentedCredentialValid` stays a denial — fail closed). Route `/authorize/:requestId`:

```ts
    try {
      const poll = await as.pollAuthorization(req.params.requestId)
      if (poll.state === 'expired') {
        res.status(404).json({ error: 'invalid_request', error_description: 'unknown or expired authorization request' })
        return
      }
      if (poll.state === 'unavailable') {
        res.status(503).json({ error: 'temporarily_unavailable', error_description: poll.reason })
        return
      }
      // pending / denied / granted: unchanged
    } catch (error) {
      res.status(500).json({ error: 'server_error', error_description: (error as Error).message })
    }
```

and drop the `getPending` pre-check (the poll answers `expired` itself; 5.2 — the throw it guarded is gone). Delete `getPending()` if nothing else uses it.

- [ ] **Step 4: retry helper** `src/shared/retry.ts`:

```ts
/**
 * Call `fn` until it succeeds or `deadline` (epoch ms) passes. For reads whose failure is transient
 * and whose caller already has a deadline — the agent's post-verification session read.
 */
export async function retryUntil<T>(fn: () => Promise<T>, deadline: number, delayMs = 2000): Promise<T> {
  for (;;) {
    try {
      return await fn()
    } catch (error) {
      if (Date.now() + delayMs > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}
```

Agent (`executor.ts`, `awaitAuthorization`): `await retryUntil(() => this.identityService.getVerificationSession(sessionId), deadline)` instead of the single call (pass `deadline` in; it is `Date.parse(expiresAt)`).

- [ ] **Step 5: Client.** `mcp-client.ts`:

```ts
/** The AS could not answer (down, Heka down, timeout). Nothing was decided; the step-up stays pending. */
export class AuthorizationUnavailableError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'AuthorizationUnavailableError'
  }
}

/** The AS no longer knows the request (restarted, or it expired). Nothing was decided; the step-up is over. */
export class AuthorizationLostError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'AuthorizationLostError'
  }
}
```

`pollAuthorization()`:

```ts
    try {
      return await this.poll(pending)
    } catch (error) {
      if (error instanceof AuthorizationUnavailableError) throw error
      this.provider.clearPending()
      if (!(error instanceof AuthorizationDeniedError)) {
        this.lastDecision = { at: new Date().toISOString(), granted: false, reason: (error as Error).message }
      }
      throw error
    }
```

`poll()`:

```ts
    let response: Response
    try {
      response = await this.fetchFn(`${pending.authorizeOrigin}/authorize/${pending.requestId}`, {
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      })
    } catch (error) {
      throw new AuthorizationUnavailableError(`the authorization server did not answer: ${(error as Error).message}`)
    }
    const body = …unchanged…

    // A button pressed on this side names the source; otherwise a token means the QR was scanned.
    const presentation =
      body.presentation &&
      presentationFrom(body.presentation, pending.source ?? (body.presentation.vpToken ? 'qr' : 'unknown'))

    if (response.status === 403) { /* unchanged: the AS answers 403 only for a decision */ }
    if (response.status === 404) {
      throw new AuthorizationLostError(body.error_description ?? 'the authorization server no longer knows this request')
    }
    if (!response.ok) {
      throw new AuthorizationUnavailableError(body.error_description ?? `the authorization server answered ${response.status}`)
    }
```

with `const POLL_TIMEOUT_MS = 10_000` at module level. Update the doc comment of `pollAuthorization` ("Any outcome other than still waiting ends the step-up" → "A decision or a lost request ends the step-up; an unavailable AS does not").

`oauth-provider.ts` `PendingAuthorization` gets:

```ts
  /** The outage of this step-up was audited once; a poll every 2 s must not repeat it. */
  unavailableAudited?: boolean
```

- [ ] **Step 6: Route + audit.** `mcp-path.ts` `/api/mcp/authorization` catch:

```ts
      } catch (error) {
        const message = (error as Error).message
        if (error instanceof AuthorizationUnavailableError) {
          if (!pending.unavailableAudited) {
            pending.unavailableAudited = true
            audit.record('engagement_refused', `MCP · ${pending.scope}`, 'UNAVAILABLE', {
              reason: message,
              note: 'the step-up stays pending; polling continues',
            })
          }
          res.status(503).json({ error: message, retrying: true })
          return
        }
        if (error instanceof AuthorizationDeniedError) {
          audit.record('denial', `MCP · ${pending.scope}`, message, error.presentation ? { presentation: error.presentation } : undefined)
          this.onDecision()
          res.status(403).json({ error: message, presentation: error.presentation })
          return
        }
        // Lost, or the code exchange failed: over, but nobody refused a credential.
        audit.record('engagement_refused', `MCP · ${pending.scope}`, 'UNAVAILABLE', { reason: message })
        this.onDecision()
        res.status(410).json({ error: message })
      }
```

Successful poll after an outage: set `pending.unavailableAudited = false` is not needed (one record per step-up is enough).

6.13 — the challenge is not a denial. In `mcp-path.ts` `/api/mcp/call` and in `chat.ts` `callThroughGate`, replace `audit.record('denial', …, 'refused: …')` with:

```ts
audit.record('authorization', `MCP · ${tool}`, `step-up required (${outcome.status === 403 ? 'insufficient scope' : 'unauthorized'})`, { via: …, requiredScope: outcome.requiredScope })
```

`onDecision` comment: "A step-up was decided: a chat paused on it continues on its own." (5.1 — the browser no longer calls resume, step 8).

- [ ] **Step 7: A2A side (tasks.ts).** In `consume()`:

```ts
        if (state === 'failed') {
          // A refused or expired presentation is a decision; anything else is the agent failing.
          const decided = task.authorization?.state === 'denied' || task.authorization?.state === 'expired'
          this.audit.record(
            decided ? 'denial' : 'engagement_refused',
            task.resource,
            decided ? (text ?? 'task failed') : 'UNAVAILABLE',
            decided
              ? task.presentation ? { presentation: task.presentation } : undefined
              : { reason: text ?? 'task failed' }
          )
        }
      }
    } catch (error) {
      task.state = 'failed'
      task.error = (error as Error).message
      // The stream broke (agent down or restarted): nobody decided anything about a credential.
      this.audit.record('engagement_refused', task.resource, 'UNAVAILABLE', { reason: task.error })
    }
```

- [ ] **Step 8: Browser.** `index.html`, inside `#mcp-auth` after `#mcp-auth-message`: `<p class="note text-bad" id="mcp-auth-unavailable"></p>`. `app.js` `pollAuthorization()` tick:

```ts
      const response = await fetch('/api/mcp/authorization')
      const data = await response.json().catch(() => ({}))

      if (response.status === 409) { /* unchanged */ }

      // The AS or Heka is down: nothing was decided, keep waiting and say why.
      if (response.status === 503) {
        el('mcp-auth-unavailable').textContent = `Authorization server unavailable — retrying: ${data.error ?? ''}`
        return
      }
      el('mcp-auth-unavailable').textContent = ''

      // Decided, or over (lost / exchange failed): the server has resumed the chat; show its view.
      if (data.granted || [403, 410, 502].includes(response.status)) {
        stopPoller('mcp-auth')
        mcp.pending = null
        if (data.granted) renderTokenStatus(data.token)
        hideAuthPanel('mcp')
        loadChat()
        return
      }
```

(the `await fetch('/api/chat/resume'…)` line goes — 5.1).

- [ ] **Step 9:** tests → PASS; `yarn typecheck && yarn test` → green (adjust existing `mcp-client.test.ts` / `mcp-path`-level assertions that expected `'denial'` for a challenge or 403 for an outage).
- [ ] **Step 10: Commit** `fix(trust-lens): a step-up ends on a decision, not on an outage` — body: AS 403 for Heka errors, client treating 404/network as denial, both reproduced on the stand; Q3/Q4 vocabulary; agent post-verify read retried.

---

### Task 4: One officer-presentation evaluation; AS input checks (3.1, 6.10, 5.3)

**Files:** Modify `src/shared/presented-credential.ts`, `src/agent/executor.ts`, `src/mcp/authorization-server.ts`, `src/scripts/capture-presentation.ts`; Test `src/shared/__tests__/presented-credential.test.ts`, `authorization-server.test.ts`

**Interfaces:**
- Produces: `officerPresentationDefinition(purpose: string)`; `evaluateOfficerPresentation(session: VerificationSessionRecord, deps: { trustedIssuer: string | undefined; statusListOrigin: string; fetchFn?: typeof fetch; log: (line: string) => void }): Promise<{ presented: PresentedCredential; status: StatusCheck }>` — throws `PresentationRefused` (with `presented` attached when read) on refusal.

- [ ] **Step 1: Failing tests** (presented-credential.test.ts already has a captured officer presentation fixture and a fake status-list fetch — reuse them):

```ts
describe('evaluateOfficerPresentation', () => {
  it('refuses when no trusted issuer is configured', async () => {
    await expect(
      evaluateOfficerPresentation(SESSION_WITH_FIXTURE, { trustedIssuer: undefined, statusListOrigin: ORIGIN, log: () => {} })
    ).rejects.toMatchObject({ name: 'PresentationRefused', reason: 'untrusted-issuer' })
  })

  it('logs the status pointer it judged a revoked credential on', async () => {
    const lines: string[] = []
    await expect(
      evaluateOfficerPresentation(SESSION_WITH_FIXTURE, { trustedIssuer: FIXTURE_ISSUER, statusListOrigin: ORIGIN, fetchFn: revokedListFetch, log: (l) => lines.push(l) })
    ).rejects.toMatchObject({ reason: 'revoked' })
    expect(lines.join('\n')).toMatch(/index \d+ on .* -> revoked/)
  })
})
```

(Use the fixture/session/fetch names the file already defines; if `PresentationRefused` has no `'untrusted-issuer'` reason, use the reason it raises for an issuer outside the trusted list.)

- [ ] **Step 2: Implement** in `presented-credential.ts`:

```ts
/** The officer credential, disclosing role and organisation only — what both relying parties ask for. */
export function officerPresentationDefinition(purpose: string) {
  return {
    id: 'FinanceDataOfficer',
    name: 'Finance Data Officer',
    purpose,
    input_descriptors: [
      {
        id: 'FinanceDataOfficer',
        name: 'Finance Data Officer credential',
        constraints: {
          limit_disclosure: 'required',
          fields: [
            { path: ['$.vct'], filter: { type: 'string', enum: [ROLE_CREDENTIAL_VCT] } },
            { path: ['$.role'], filter: { type: 'string', enum: [OFFICER_CREDENTIAL.role] } },
            { path: ['$.org'], filter: { type: 'string' } },
          ],
        },
      },
    ],
  }
}

/**
 * The relying party's decision on a presentation Heka verified: issuer, type, role and live status,
 * judged on the presented token. One implementation for the agent and the AS, so the two paths
 * cannot drift apart on what they accept.
 */
export async function evaluateOfficerPresentation(
  session: VerificationSessionRecord,
  deps: { trustedIssuer: string | undefined; statusListOrigin: string; fetchFn?: typeof fetch; log: (line: string) => void }
): Promise<{ presented: PresentedCredential; status: StatusCheck }> {
  if (!deps.trustedIssuer) {
    throw new PresentationRefused('untrusted-issuer', 'no trusted issuer configured — run `yarn seed`')
  }
  let presented: PresentedCredential | undefined
  try {
    presented = readPresentedCredential(session)
    const status = await assertPresentedCredentialValid(
      presented,
      {
        trustedIssuers: [deps.trustedIssuer],
        requiredVct: ROLE_CREDENTIAL_VCT,
        statusListOrigin: deps.statusListOrigin,
        credentialLabel: OFFICER_CREDENTIAL.role,
        requiredClaims: { role: OFFICER_CREDENTIAL.role },
      },
      deps.fetchFn ?? fetch
    )
    deps.log(`status checked: index ${status.statusListIndex} on ${status.statusListCredential} -> live`)
    return { presented, status }
  } catch (error) {
    if (!(error instanceof PresentationRefused)) throw error
    const pointer = presented?.credentialStatus
    if (error.reason === 'revoked' && pointer) {
      deps.log(`status checked: index ${pointer.statusListIndex} on ${pointer.statusListCredential} -> revoked`)
    }
    if (error.reason === 'foreign-status-list' && pointer) {
      deps.log(`status list origin ${statusListOriginOf(pointer) ?? '(not a URL)'} is not ${deps.statusListOrigin}`)
    }
    error.presented = presented
    throw error
  }
}
```

Add `public presented?: PresentedCredential` to `PresentationRefused` (mutable, set by the evaluator). Use the existing reason string for an untrusted issuer if it differs from `'untrusted-issuer'`. Import `VerificationSessionRecord` from `./identity-service`, `OFFICER_CREDENTIAL` from `./demo-config`, `ROLE_CREDENTIAL_VCT` from `../core/types`.

Agent `awaitAuthorization` becomes:

```ts
    try {
      const session = await retryUntil(() => this.identityService.getVerificationSession(sessionId), deadline)
      const evaluated = await evaluateOfficerPresentation(session, {
        trustedIssuer: loadState().issuerDid,
        statusListOrigin: this.identityService.baseOrigin,
        log: (line) => console.log(`[agent] ${line}`),
      })
      this.state.statusChecked(sessionId, evaluated.status)
      return evaluated
    } catch (error) {
      if (!(error instanceof PresentationRefused)) throw error
      const result = deniedResult(sessionId, error.message, error.presented, error.reason)
      if (result.status) this.state.statusChecked(sessionId, result.status)
      console.log(`[agent] presentation refused (${error.reason}): ${error.message}`)
      throw new AuthorizationDenied(error.message, result)
    }
```

(This also closes 6.6's "no trusted issuer" half: the denial now carries a `result`, so `authorizationDecided` runs.) AS `pollAuthorization` uses the same call with `log: (line) => console.log(`[as] ${line}`)`, deleting its copy; the `typeof role !== 'string'` block stays only for `org` (5.3): `if (typeof presented.claims.org !== 'string')`. Both use `officerPresentationDefinition('Authorize preparation of a supplier payment export')` / `('Authorize export of supplier bank details')`; `capture-presentation.ts` imports it too.

6.10 — `/authorize`:

```ts
    if (!redirect_uri || !resource || !URL.canParse(String(redirect_uri))) {
      res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri (a URL) and resource are required' })
      return
    }
```

and in `pollAuthorization` build `redirectTo` **before** `this.codes.set` / `this.pending.delete`.

- [ ] **Step 3:** tests → PASS; `yarn typecheck && yarn test` → green.
- [ ] **Step 4: Commit** `refactor(trust-lens): one evaluation of the officer presentation for both relying parties`.

---

### Task 5: `yarn seed --reset` without restarting anything (9.1, 9.2, 9.3, prev #5, 9.10, prev #6)

**Files:** Modify `src/seed/state.ts`, `src/web/server.ts`, `src/shared/simulated-wallet.ts`, `src/web/tasks.ts`, `src/console/server.ts`; Create `src/seed/__tests__/state.test.ts`

**Interfaces:** Produces `seedFingerprint(state: SeedState): string` in `seed/state.ts`.

- [ ] **Step 1: Failing test** `src/seed/__tests__/state.test.ts`:

```ts
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('seed state', () => {
  let cwd: string
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'seed-state-'))
    vi.spyOn(process, 'cwd').mockReturnValue(cwd)
    vi.resetModules()
  })
  afterEach(() => vi.restoreAllMocks())

  it('writes atomically: no temp file is left and the state reads back', async () => {
    const { saveState, loadState } = await import('../state')
    saveState({ issuerDid: 'did:x', dids: {}, statusIndexes: { officer: 3 } })
    expect(loadState().issuerDid).toBe('did:x')
    expect(existsSync(join(cwd, '.seed-state.json.tmp'))).toBe(false)
  })

  it('fingerprints what a minted credential depends on', async () => {
    const { seedFingerprint } = await import('../state')
    const a = seedFingerprint({ issuerDid: 'did:a', statusListId: 'l', dids: {}, statusIndexes: { officer: 3 } })
    const b = seedFingerprint({ issuerDid: 'did:b', statusListId: 'l', dids: {}, statusIndexes: { officer: 3 } })
    expect(a).not.toBe(b)
  })
})
```

- [ ] **Step 2:** run → FAIL (`seedFingerprint` missing).

- [ ] **Step 3: Implement.** `state.ts`:

```ts
/**
 * Written to a temp file and renamed: the AS and the agent read this file on every decision, and a
 * half-written file parses as "no issuer", which would turn a seed run into spurious denials.
 */
export function saveState(state: SeedState): void {
  const temp = `${STATE_PATH}.tmp`
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(temp, STATE_PATH)
}

/** What a credential minted from this state depends on; a change means it was issued by a world that is gone. */
export function seedFingerprint(state: SeedState): string {
  return [state.issuerDid, state.statusListId, state.statusIndexes.officer].join('|')
}
```

`web/server.ts` — read the anchor per use (9.1):

```ts
  /** Read per use: `yarn seed --reset` mints a new issuer, and a cached one would refuse everything. */
  const trustedIssuer = (): string => {
    const issuerDid = loadState().issuerDid
    if (!issuerDid) throw new Error('no seed state — run `yarn seed` first')
    return issuerDid
  }
```

`verifierOptions` returns `trustedIssuers: [trustedIssuer()]`; `/api/config` uses `[loadState().issuerDid]`; the startup check and log stay.

`simulated-wallet.ts` — memoized start, re-mint on a changed seed (9.2, prev #6):

```ts
export class SimulatedWallet {
  private agent: HolderAgent | undefined
  /** Memoized: two first presentations at once must wait for one start, not race two. */
  private ready: Promise<HolderAgent> | undefined
  /** The seed the held credential was minted from. */
  private mintedFor: string | undefined

  public initialize(): Promise<HolderAgent> {
    this.ready ??= this.start().catch(async (error) => {
      this.ready = undefined
      await this.shutdown()
      throw error
    })
    return this.ready
  }

  private async start(): Promise<HolderAgent> {
    const state = loadState()
    if (!state.issuerDid || state.statusIndexes.officer === undefined || !state.statusListId) {
      throw new Error('no seed state — run `yarn seed` first')
    }
    const agent = createHolderAgent('trust-lens-simulated-wallet')
    this.agent = agent
    await agent.initialize()
    const compact = await claimCredentialOffer(agent, await createOfficerOffer(this.identityService, state))
    await storeCredential(agent, compact)
    this.mintedFor = seedFingerprint(state)
    console.log(`[wallet] simulated holder ready, holding a ${OFFICER_CREDENTIAL.role} credential`)
    return agent
  }

  public async present(authorizationRequest: string): Promise<void> {
    // After `yarn seed --reset` the held credential names an issuer nobody trusts any more.
    if (this.mintedFor && this.mintedFor !== seedFingerprint(loadState())) {
      console.log('[wallet] the seed changed; minting a fresh credential')
      await this.shutdown()
    }
    const agent = await this.initialize()
    // …rest unchanged, using `agent`…
  }

  public async shutdown(): Promise<void> {
    const agent = this.agent
    this.agent = undefined
    this.ready = undefined
    this.mintedFor = undefined
    await agent?.shutdown()
  }
}
```

(`holdsCredential` goes.) `tasks.ts` `presentToAuthorizationServer`: drop the `await this.wallet.initialize()` line — `present` initializes.

`console/server.ts` (9.3, prev #5): delete the `const state = loadState()` captured in `main()` except for the startup check; each route calls `const state = loadState()` itself; the offer route no longer writes `state.officerOffer` / `saveState` (drop the `saveState` import). Update the file comment: "Status is read live…" stays; add "Seed state is read per request, so a reseed needs no restart."

- [ ] **Step 4:** tests → PASS; `yarn typecheck && yarn test` → green.
- [ ] **Step 5: Commit** `fix(trust-lens): a reseed needs no restart` — body: web cached the issuer, the simulated holder kept the old credential, the console minted from and wrote back its boot-time state; atomic write.

---

### Task 6: Discovery tells unreachable from unknown; verdicts keyed by publisher (9.4, 6.4, 4.1–4.3, 7.1, 8.4, 2.3)

**Files:** Modify `src/web/server.ts`, `src/web/mcp-path.ts`, `src/web/mcp-client.ts`, `src/web/public/app.js`

**Interfaces:**
- Produces: `discover(query: string, domains?: string[]): Promise<{ results: DiscoveredEntry[]; unreachable: string[] }>`; `McpPathDeps.discover(domain: string)` returns the same shape; `/api/verify` body `{ targets?: Array<{ identifier: string; publisher: string }>; identifiers?: string[] }`, response `{ results, unreachable }` where a missing target is `{ identifier, publisher, verdict: 'UNAVAILABLE', engageable: false, evidence: { failureDetail } }`; `/api/engage` body `{ identifier, publisher?, contextId?, prompt? }` → `503` + `engagement_refused/UNAVAILABLE` when the publisher is unreachable.

- [ ] **Step 1: Server.** `server.ts`:

```ts
/** Every outbound fetch on the demo path is bounded: a hung (not refused) publisher must not freeze a click. */
const FETCH_TIMEOUT_MS = 5_000
const timedFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS) })

async function fetchCatalog(domain: string): Promise<AiCatalog> {
  const response = await timedFetch(`https://${domain}${SITE_SUFFIX}/.well-known/ai-catalog.json`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return (await response.json()) as AiCatalog
}

/** The publishers' catalogs as served now; a publisher that cannot be read is named, not dropped. */
async function discover(query: string, domains: string[] = PUBLISHERS) {
  const results: DiscoveredEntry[] = []
  const unreachable: string[] = []
  await Promise.all(
    domains.map(async (domain) => {
      try {
        for (const entry of (await fetchCatalog(domain)).entries) {
          const score = relevance(entry, query)
          if (score > 0) results.push({ entry, servingDomain: domain, score, source: domain })
        }
      } catch (error) {
        unreachable.push(domain)
        console.warn(`[web] could not read the catalog at ${domain}: ${(error as Error).message}`)
      }
    })
  )
  return { results: results.sort((a, b) => b.score - a.score || a.source.localeCompare(b.source)), unreachable }
}
```

`verifierOptions` adds `fetchFn: timedFetch` to its returned object (core passes it to attestation, card and status-list fetches; the status list keeps its own signal). `/api/discovery` returns `unreachable` too. `/api/verify`:

```ts
  app.post('/api/verify', async (req, res) => {
    try {
      const body = req.body ?? {}
      const wanted: Array<{ identifier: string; publisher?: string }> = Array.isArray(body.targets)
        ? body.targets.map((t: { identifier?: unknown; publisher?: unknown }) => ({ identifier: String(t.identifier ?? ''), publisher: t.publisher ? String(t.publisher) : undefined }))
        : Array.isArray(body.identifiers)
          ? body.identifiers.map((identifier: unknown) => ({ identifier: String(identifier) }))
          : []
      const { results: discovered, unreachable } = await discover('')
      const matches = (item: DiscoveredEntry, w: { identifier: string; publisher?: string }) =>
        item.entry.identifier === w.identifier && (!w.publisher || item.servingDomain === w.publisher)
      const targets = wanted.length ? discovered.filter((item) => wanted.some((w) => matches(item, w))) : discovered

      const options = await verifierOptions()
      // Independent entries, verified together; audited in order so the trail reads as the list does.
      const verified = await Promise.all(targets.map((t) => verifyEntry(t.entry, { servingDomain: t.servingDomain }, options)))
      const results = targets.map(({ entry, servingDomain }, index) => {
        const result = verified[index]
        const event = audit.record('verification', entry.displayName, result.verdict, result.evidence)
        return { identifier: entry.identifier, publisher: servingDomain, displayName: entry.displayName, verdict: result.verdict,
          engageable: result.verdict === Verdict.Verified, evidence: result.evidence, auditId: event.id }
      })

      // Asked for, but its publisher could not be read: a refusal to call it VERIFIED, and recorded.
      for (const w of wanted) {
        if (targets.some((t) => matches(t, w)) || !w.publisher || !unreachable.includes(w.publisher)) continue
        const failureDetail = `the catalog at ${w.publisher} could not be read`
        audit.record('verification', w.identifier, 'UNAVAILABLE', { failureDetail })
        results.push({ identifier: w.identifier, publisher: w.publisher, displayName: w.identifier, verdict: 'UNAVAILABLE',
          engageable: false, evidence: { failureDetail } as never, auditId: '' })
      }
      res.json({ results, unreachable })
    } catch (error) { res.status(500).json({ error: (error as Error).message }) }
  })
```

(Type the pushed object with a local interface instead of `as never` — e.g. `interface VerifyResult { …; evidence: unknown }` — no `as never` in new code.)

`/api/engage`:

```ts
    const identifier = String(req.body?.identifier ?? '')
    const publisher = req.body?.publisher ? String(req.body.publisher) : undefined
    try {
      const { results, unreachable } = await discover('', publisher ? [publisher] : PUBLISHERS)
      const target = results.find((item) => item.entry.identifier === identifier && (!publisher || item.servingDomain === publisher))
      if (!target) {
        if (unreachable.length) {
          const reason = `the catalog at ${unreachable.join(', ')} could not be read`
          const refusal = audit.record('engagement_refused', identifier, 'UNAVAILABLE', { reason })
          res.status(503).json({ error: `refused: ${reason}`, verdict: 'UNAVAILABLE', auditId: refusal.id })
          return
        }
        res.status(404).json({ error: 'unknown resource' })
        return
      }
```

Rewrite the comment above `/api/engage` (2.3): "…The cost is a fresh fetch of the catalog, attestation, card and status list; the alternative is a gate that trusts the caller."

Startup warm-up (4.2), after `listen`: `verifierOptions().catch((error) => console.warn(`[web] verifier not ready yet: ${(error as Error).message}`))`.

`/api/wallet/link` DELETE (8.4): wrap in `try { await walletLink.unlink(); res.json(walletLink.status) } catch (error) { res.status(500).json({ error: (error as Error).message }) }` — same in `console/server.ts`.

- [ ] **Step 2: Gate.** `mcp-path.ts`: `McpPathDeps.discover(domain: string): Promise<{ results: …; unreachable: string[] }>`; server passes `(domain) => discover('', [domain])`. `gate()`:

```ts
    let result: VerificationResult
    let target: { entry: AiCatalogEntry; servingDomain: string } | undefined
    try {
      // Only the engaged publisher's catalog: the entry is re-fetched from where it was engaged.
      const { results } = await this.deps.discover(engagement.servingDomain)
      target = results.find((item) => item.entry.identifier === engagement.identifier)
      if (target) result = await verifyEntry(target.entry, { servingDomain: target.servingDomain }, await this.deps.verifierOptions())
    } catch (error) {
      target = undefined
      console.warn(`[web] gate could not verify: ${(error as Error).message}`)
    }
    if (!target) { /* the existing UNAVAILABLE refusal */ }
```

(declare `let result: VerificationResult | undefined` and narrow after the `!target` branch with `if (!result)` → same UNAVAILABLE refusal.) `/api/mcp/call`: move `const gate = await this.gate(…)` inside the existing `try`.

6.5 (failed re-Engage) — `mcp-client.ts` `connect()` connects the new client first and swaps only on success:

```ts
  public async connect(url: string): Promise<void> {
    const observe: typeof fetch = …unchanged…
    const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: this.provider, fetch: observe })
    const client = new Client({ name: 'trust-lens', version: '1.0.0' })
    // Connect before letting go of the old client: a failed re-engage leaves the working one in place.
    await client.connect(transport)
    const previous = this.client
    this.client = client
    this.transport = transport
    this.serverUrl = url
    await previous?.close().catch(() => undefined)
  }
```

and `McpPath.engage` sets `this.engagement`/`this.connected` only after `connect` resolved (already so).

- [ ] **Step 3: Browser** (`app.js`): verdicts keyed by publisher and identifier.

```js
const keyOf = (result) => `${result.publisher}|${result.identifier}`
```

`render()` uses `state.verdicts.get(keyOf(result))`, `data-details="${escapeHtml(keyOf(result))}"`, `data-engage="${escapeHtml(keyOf(result))}"`. `openDrawer(key)` looks up `state.results.find((r) => keyOf(r) === key)` and `state.verdicts.get(key)`. `engage(key)` sends `{ identifier: result.identifier, publisher: result.publisher }`. `search()` shows unreachable publishers:

```js
  const unreachable = data.unreachable ?? []
  el('score-note').textContent = [
    state.results.length ? `Score: ${data.scoreMeaning}` : '',
    unreachable.length ? `Could not read: ${unreachable.join(', ')}` : '',
  ].filter(Boolean).join(' · ')
```

`verifyAll()` (uses `api()` from Task 10 once it exists; until then plain fetch):

```js
    const response = await fetch('/api/verify', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targets: state.results.map((r) => ({ identifier: r.identifier, publisher: r.publisher })) }) })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) { showError(`Verify failed: ${data.error ?? response.status}`); return }
    // A verdict from an earlier pass must not outlive a pass that could not reach its publisher.
    state.verdicts.clear()
    for (const result of data.results ?? []) state.verdicts.set(keyOf(result), result)
    render()
```

`showError` is added in Task 10; in this task define the minimal version at the top of the file: `function showError(message) { el('page-error').textContent = message; el('page-error').hidden = !message }` and add `<p id="page-error" class="note text-bad" hidden></p>` under the header in `index.html`.

- [ ] **Step 4:** `yarn typecheck && yarn test` → green.
- [ ] **Step 5: Commit** `fix(trust-lens): an unreachable publisher is a recorded refusal, not an empty list` — body: 9.4 reproduced; URN-only keys (6.4); timeouts (7.1); one catalog per gate (4.3); parallel verify (4.1).

---

### Task 7: Bounded waits — Heka, OpenAI, the AS, the agent's channel (7.1–7.4, 4.5)

**Files:** Modify `src/shared/identity-service.ts`, `src/agent/invoice-work.ts`, `src/web/oauth-provider.ts`, `src/agent/executor.ts`, `src/agent/state.ts`; Test `src/agent/__tests__/state.test.ts`

- [ ] **Step 1: Failing test** (`state.test.ts`):

```ts
it('journals one close per outage, not one per reconnect attempt', () => {
  const state = new AgentState()
  state.channelState('open')
  for (let i = 0; i < 5; i++) {
    state.channelState('closed', 'code 1006')
    state.channelState('connecting')
  }
  expect(state.journal.list().filter((e) => e.type === 'channel.closed')).toHaveLength(1)
  state.channelState('open')
  state.channelState('closed', 'code 1006')
  expect(state.journal.list().filter((e) => e.type === 'channel.closed')).toHaveLength(2)
})
```

- [ ] **Step 2:** run → FAIL (5 closes).

- [ ] **Step 3: Implement.**

`identity-service.ts` (7.2):

```ts
/** Interactive calls (sessions, offers, status lists) must fail fast; a poll every 2 s depends on them. */
const INTERACTIVE_TIMEOUT_MS = 15_000
/** Ledger writes really are slow: a did:hedera is anchored on testnet. */
const LEDGER_TIMEOUT_MS = 120_000
```

axios default `timeout: INTERACTIVE_TIMEOUT_MS`; `createDid`, `prepareWallet`, `createIssuer`, `createStatusList` pass `{ timeout: LEDGER_TIMEOUT_MS }` as the request config.

`invoice-work.ts` (7.3, 4.5):

```ts
/** OpenAI's SDK waits ten minutes by default; the operator is watching a task that already passed authorization. */
const LLM_TIMEOUT_MS = 15_000

let ai: Promise<{ generate: (input: { prompt: string }) => Promise<{ text?: string }> }> | undefined

/** One Genkit instance per process, built on first use. */
function getAi() {
  ai ??= (async () => {
    const { genkit } = await import('genkit')
    const { openAI } = await import('@genkit-ai/compat-oai/openai')
    return genkit({ plugins: [openAI()], model: openAI.model(LLM_MODEL) })
  })()
  return ai
}

async function llmReport(prompt: string): Promise<string> {
  const generate = (await getAi()).generate({ prompt: /* unchanged prompt lines */ })
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`no answer within ${LLM_TIMEOUT_MS / 1000}s`)), LLM_TIMEOUT_MS).unref()
  )
  const { text } = await Promise.race([generate, timeout])
  return text?.trim() || deterministicReport()
}
```

(If Genkit's `generate` return type does not fit the narrow type above, type `ai` as `Promise<Awaited<ReturnType<typeof import('genkit')['genkit']>>>` — no `any`.)

`oauth-provider.ts` (7.1): `const response = await this.fetchFn(authorizationUrl.toString(), { signal: AbortSignal.timeout(10_000) })`.

Agent channel backoff (7.4), `executor.ts`:

```ts
  /** Consecutive failed connects; the delay doubles up to 30 s so an outage does not flood the journal. */
  private reconnects = 0
  …
    socket.on('open', () => { this.reconnects = 0; /* existing */ })
    socket.on('close', (code: number) => {
      const delay = Math.min(30_000, 3_000 * 2 ** this.reconnects++)
      console.log(`[agent] notification channel closed (${code}); reconnecting in ${delay / 1000}s`)
      this.state.channelState('closed', `code ${code}`)
      setTimeout(() => this.connectNotifications(), delay)
    })
```

`state.ts` `channelState`: journal `channel.closed` only if the channel was open since the last close:

```ts
  /** True after a close is journaled, until the channel opens again: one record per outage. */
  private outage = false
  …
    if (state === 'open') { this.outage = false; /* existing */ }
    …
    if (state === 'closed' && !this.outage) {
      this.outage = true
      this.journal.record({ /* existing */ })
    }
```

- [ ] **Step 4:** tests → PASS; `yarn typecheck && yarn test` → green.
- [ ] **Step 5: Commit** `fix(trust-lens): every wait on the demo path is bounded`.

---

### Task 8: Fail at start, not mid-demo — listen errors and the DIDComm inbound port (8.2, 8.3, 1.8, 2.7)

**Files:** Create `src/shared/listen.ts`; Modify `src/web/server.ts`, `src/agent/index.ts`, `src/console/server.ts`, `src/mcp/auth-server.ts`, `src/mcp/server.ts`, `src/shared/wallet-link-credo.ts`, `src/shared/wallet-link.ts`, `.env.example`

- [ ] **Step 1: listen helper.**

```ts
// src/shared/listen.ts
import type { Server } from 'node:http'

/**
 * Express 5 hands a listen error to the callback instead of throwing, so an ignored argument turns
 * EADDRINUSE into a success line while the browser keeps talking to the old process. Exit instead.
 */
export function listenOrExit(
  app: { listen(port: number, callback: (error?: Error) => void): Server },
  port: number,
  label: string,
  onReady: () => void
): Server {
  return app.listen(port, (error) => {
    if (error) {
      console.error(`[${label}] FATAL cannot listen on port ${port}: ${error.message}`)
      process.exit(1)
    }
    onReady()
  })
}
```

Replace `app.listen(PORT, () => { … })` in web, agent, console, AS and MCP (`createResourceServer(…)` is an Express app) with `listenOrExit(app, PORT, 'web', () => { … })` etc. `sites.ts` uses `https.createServer().listen` without an error listener — Node throws on EADDRINUSE there, which is already loud; leave it.

- [ ] **Step 2: inbound transport goes (Q5).** `wallet-link-credo.ts`: `credoWalletTransport(options: { label: string })`; remove `DidCommHttpInboundTransport` import and registration and the `endpoints` option (`new DidCommModule({})`). File comment: "Send-only: the sender is a `did:key` with no endpoint, so Credo marks the message `return_route: all`; nothing listens here, so no port can collide." `wallet-link.ts` comment lines 17–21: drop "The inbound HTTP transport is kept … end to end." Remove `DIDCOMM_PORT` from `web/server.ts` and `console/server.ts`; `TRUST_LENS_DIDCOMM_PORT`/`TRUSTCO_CONSOLE_DIDCOMM_PORT` from `.env.example`.

- [ ] **Step 3:** `yarn typecheck && yarn test` → green. Manual check: start `yarn web` twice — the second exits with `FATAL cannot listen on port 4000` (Task 13 step).
- [ ] **Step 4: Commit** `fix(trust-lens): a busy port fails the start, not the demo` — body: Express 5 listen callback; Credo's inbound listener had no error handler and bound lazily on first Send; validation of DIDComm delivery is a wallet step for the person.

---

### Task 9: The agent's lifecycle — Run again in this context, cancel, late presentations (Q2/1.1, 9.14, 6.6, 6.7, 6.9, 1.5, 9.11)

**Files:** Modify `src/agent/executor.ts`, `src/agent/state.ts`, `src/agent/extension.ts`, `src/web/tasks.ts`, `src/web/server.ts`, `src/web/public/app.js`, `src/web/public/index.html`; Test `src/agent/__tests__/state.test.ts`, `src/web/__tests__/tasks.test.ts`

**Interfaces:**
- Produces: `AgentState.cancelPendingAuthorization(taskId: string): void`; `TaskTracker.start(target: { identifier: string; publisher: string; resource: string; card?: AgentCard }, prompt: string, preflight?, contextId?: string)`; `TrackedTask.identifier`, `TrackedTask.publisher`; `/api/engage` accepts `contextId`.

- [ ] **Step 1: Failing tests** (`state.test.ts`):

```ts
it('closes a pending authorization when its task is cancelled', () => {
  const state = new AgentState()
  state.authorizationRequested({ sessionId: 's1', taskId: 't1', contextId: 'c1', expiresAt: 'later' })
  state.cancelPendingAuthorization('t1')
  expect(state.isDecided('s1')).toBe(true)
  expect(state.authorizations.get('s1')).toMatchObject({ outcome: 'denied', reason: 'task cancelled' })
})

it('records a presentation after the decision as ignored, without a verifiedAt', () => {
  const state = new AgentState()
  state.authorizationRequested({ sessionId: 's1', taskId: 't1', contextId: 'c1', expiresAt: 'later' })
  state.authorizationDecided({ sessionId: 's1', outcome: 'denied', reason: 'no presentation was received in time' })
  state.sessionState('s1', 'ResponseVerified')
  expect(state.authorizations.get('s1')?.verifiedAt).toBeUndefined()
  expect(state.journal.list()[0].text).toMatch(/after the agent stopped waiting/)
})
```

`tasks.test.ts` — the file tests `applyStatusUpdate`; add a check that `start` sends the context:

```ts
it('continues an earlier context when asked to', async () => {
  const sent: unknown[] = []
  const tracker = new TaskTracker(new AuditLog(), fakeIdentityService, {
    client: () => ({ sendMessageStream: async function* (params: unknown) { sent.push(params) } }),
  })
  await tracker.start({ identifier: 'urn:x', publisher: 'acme', resource: 'Acme' }, 'again', undefined, 'ctx-1')
  await new Promise((r) => setTimeout(r, 0))
  expect(sent[0]).toMatchObject({ message: { contextId: 'ctx-1' } })
})
```

This needs a client factory seam: `TaskTracker` constructor becomes `(audit, identityService, options: { agentUrl: string; client?: (card: AgentCard | string) => Pick<A2AClient, 'sendMessageStream'> })`. Default `client` is `(card) => new A2AClient(card)`.

- [ ] **Step 2:** run → FAIL.

- [ ] **Step 3: Implement.**

`state.ts`:

```ts
  /** `tasks/cancel` ends the wait; the record must not stay "pending" on the page forever. */
  public cancelPendingAuthorization(taskId: string): void {
    for (const record of this.authorizations.values()) {
      if (record.taskId === taskId && !record.outcome) {
        this.authorizationDecided({ sessionId: record.sessionId, outcome: 'denied', reason: 'task cancelled' })
      }
    }
  }
```

`sessionState`: after the `record.sessionState = state` line —

```ts
    if (record.outcome) {
      // Heka's session outlives the agent's deadline; a wallet can still present after the decision.
      this.journal.record({ type: 'session.state', ...ids(record), text: `session ${state} after the agent stopped waiting — ignored` })
      return
    }
```

(and remove the now-duplicated journal line for that case). `authorizedContexts` stays (Q2).

`executor.ts`: `sessionToContext` → `private readonly ownSessions = new Set<string>()` (`.add`, `.has`, `.delete`, `[...this.ownSessions]`). `cancelTask` calls `this.state.cancelPendingAuthorization(taskId)` after publishing. In `execute`, `say` begins with:

```ts
      // `tasks/cancel` already published the final `canceled`; anything after it would reopen the task.
      if (this.cancelled.has(taskId)) throw new TaskCancelled()
```

and the `catch` starts `if (error instanceof TaskCancelled || this.cancelled.has(taskId)) return`.

`extension.ts` file comment, after the spec paragraph (9.11): "The agent marks only `completed`/`failed` final, so `auth-required` reaches a client only on a stream (or with `blocking: false` and `tasks/get`); a blocking `message/send` waits until the task ends. The Trust Lens streams."

`tasks.ts`: `TrackedTask` gains `identifier: string; publisher: string`. `start(target, prompt, preflight, contextId)`:

```ts
    // The verified card's bytes, not a second fetch of the agent's live card (prev #2).
    const client = this.options.client(target.card ?? this.options.agentUrl)
    …
    const message: Message = { messageId: randomUUID(), kind: 'message', role: 'user', parts: [{ kind: 'text', text: prompt }],
      ...(contextId ? { contextId } : {}) }
```

`server.ts` `/api/engage`: `tasks.start({ identifier, publisher: target.servingDomain, resource: target.entry.displayName, card: result.card as AgentCard | undefined }, prompt, preflight, req.body?.contextId ? String(req.body.contextId) : undefined)`; `new TaskTracker(audit, identityServiceFromEnv(), { agentUrl: AGENT_URL })`. `/api/tasks` list adds `identifier`, `publisher`.

`index.html` task view, next to `#task-back`: `<button id="task-again" hidden>Run again in this context</button>`. `app.js` `renderTask`:

```js
  // A completed task's context is remembered by the agent: running again there shows the cached
  // authorization — and, after Forget authorizations or a revocation, that it asks again.
  const again = el('task-again')
  again.hidden = !(task.state === 'completed' && task.a2a?.contextId)
  again.dataset.identifier = task.identifier
  again.dataset.publisher = task.publisher
  again.dataset.context = task.a2a?.contextId ?? ''
```

and wiring: `el('task-again').addEventListener('click', (e) => engage(`${e.currentTarget.dataset.publisher}|${e.currentTarget.dataset.identifier}`, e.currentTarget.dataset.context))`; `engage(key, contextId)` sends `contextId` when given.

- [ ] **Step 4:** tests → PASS; `yarn typecheck && yarn test` → green.
- [ ] **Step 5: Commit** `feat(trust-lens): run again in an authorized context; cancelled and late presentations settle`.

---

### Task 10: The browser fails visibly — `api()`, busy flags, one authorization shape (3.3, 3.2, 6.3, 4.4, 9.9, 4.9)

**Files:** Modify `src/web/public/app.js`, `src/web/public/index.html`, `src/web/mcp-path.ts`, `src/console/public/console.js`

**Interfaces:** Produces `api(url, init?) → Promise<{ ok: boolean; status: number; data: any }>` and `showError(message)` in `app.js`; `authorizationView(pending)` returns `AuthorizationView` (`src/web/presentation.ts`) plus `{ message, scope }`.

- [ ] **Step 1: `api()`.** Top of `app.js`:

```js
const API_TIMEOUT_MS = 20_000

/**
 * Every call goes through here: bounded, tolerant of a non-JSON error page, and never throwing — a
 * click whose request failed says so instead of silently doing nothing.
 */
async function api(url, init = {}) {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(API_TIMEOUT_MS) })
    const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
    return { ok: response.ok, status: response.status, data }
  } catch (error) {
    return { ok: false, status: 0, data: { error: `request failed: ${error.message}` } }
  }
}

const postJson = (url, body) =>
  api(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
```

Replace every `fetch(…)` + `.json()` pair in `app.js` with `api`/`postJson`. Where a failure is user-visible (verify, engage, link, unlink, send, simulate, drop token, chat send/reset), call `showError(data.error)`; successful actions call `showError('')`.

- [ ] **Step 2: Busy flags.** `startPoller` skips a tick while the previous one runs:

```js
function startPoller(key, tick, ms) {
  stopPoller(key)
  let running = false
  const guarded = async () => {
    // A slow answer must not overlap the next tick: two polls of one step-up could both settle it.
    if (running) return
    running = true
    try { await tick() } finally { running = false }
  }
  pollers.set(key, setInterval(guarded, ms))
  guarded()
}
```

`auth[panel]` gains `sending: false`; `sendToWallet` sets it true for the duration; `renderSendButton`:

```js
  button.disabled = !linked || auth[panel].sending
  button.textContent = auth[panel].sending ? 'Sending…' : delivery ? 'Resend to wallet' : 'Send to wallet'
```

(`hideAuthPanel` resets to `{ request: null, delivery: null, authorization: null, sending: false }`.) `engage()` disables the clicked button and shows "Engaging…" until the answer; `linkWallet` disables `#wallet-did` while linking.

- [ ] **Step 3: one authorization shape (3.2).** `mcp-path.ts`:

```ts
/** The step-up as the UI and the audit see it: the same AuthorizationView an A2A task carries, plus what the AS said. */
export function authorizationView(pending: PendingAuthorization): AuthorizationView & { message?: string; scope: string } {
  return {
    request: pending.authorizationRequest,
    sessionId: pending.session?.id,
    state: toAuthorizationState(pending.session?.state ?? 'RequestCreated'),
    requested: pending.requested,
    delivery: pending.delivery,
    source: pending.source,
    message: pending.message,
    scope: pending.scope,
  }
}
```

`/api/mcp/authorization` success JSON adds `authorization: authorizationView(pending)`. In `app.js` delete `SESSION_STATE` and `mcpAuthorizationFrom`; `renderChat` uses `view.authorization` directly; the poll tick replaces the session-state mapping with `if (data.authorization) mcp.pending.authorization = data.authorization`.

- [ ] **Step 4: Render only on change.** `renderTask(task)` returns early when `JSON.stringify(task) === state.renderedTask` (set it after rendering; reset in `watchTask`). 9.9 — `mcp-path.ts` `startChat`: first line `this.chatUnavailable = 'starting the model…'` (before the `await`). 4.9 — `console.js`: the 5 s interval skips while `document.hidden` or while the previous `load()` runs (same `running` guard as above).

- [ ] **Step 5:** `yarn typecheck && yarn test` → green; open the UI and click through each tab with the browser console open — no errors (Task 13 repeats this formally).
- [ ] **Step 6: Commit** `fix(trust-lens): the UI says when a request failed and does not double-submit`.

---

### Task 11: Dead code, unreachable code and stale comments (review §1, §2, §5; tsc unused)

**Files:** as listed per bullet.

- [ ] **Step 1: Remove.**
  - `src/seed.ts`: unused `TRUSTCO` import. `src/web/server.ts`: unused `readFileSync` import.
  - `src/shared/identity-service.ts`: `findIssuer()`, `dcql`/`responseMode` params, `VerificationSessionResponse.authorizationRequestObject`, `DidDocument.verificationMethod`.
  - `src/shared/credential-verifier.ts`: the per-process `didCache` (Credo 0.7 already caches resolutions for 300 s); comment: "Revocation is never cached: it is live state, checked on every verdict."
  - `src/web/public/index.html`: `#mcp-countdown`; `app.js`: `'revocation'` from `REFUSALS`; unused `id="wallet"` in web `index.html`, `id="wallet"`/`id="issuer"` in console `index.html` (grep first that no CSS/JS uses them).
  - `src/mcp/authorization-server.ts`: `IssuedCode.presented` and `.status` if still unread after Task 4.
- [ ] **Step 1b: Small fixes found next to dead code.**
  - 9.13 — `console/server.ts` `/api/credentials/:key/status`: `if (!Object.hasOwn(state.statusIndexes, key))` → 404, so `constructor` and friends never reach Heka; parse `revoked` strictly (`req.body?.revoked === true`).
  - 9.12 — console: a sent offer is "handed to the wallet's mediator", not "delivered" (`console.js` text and the audit's `delivered` field renamed `handedOver`). Credo's HTTP outbound transport does not check the response.
  - 3.7 — `authorization-result.ts`: the revoked `StatusCheck` copies `statusListCredential` and `statusListIndex` only, not the whole issuer-controlled claim.
  - 3.9 — `holder.ts:103`: use the static `@credo-ts/core` import instead of `await import(...)`.
  - 4.8 — `sites.ts`: build the two `express.static` handlers once, in a `Record<host, handler>`.
- [ ] **Step 2: Fix comments.**
  - `app.js:30-31` → "Task and step-up pollers outlive view switches; the list and chat pollers are view-scoped."
  - `verify.ts:4` "design §4.4", `types.ts:5`, `types.ts:67` → point to `docs/ARCHITECTURE.md#verification-procedure` and `spec/ADR-001`.
  - `holder.ts:59-60` → "see docs/OPERATIONS.md for the loopback bridge".
  - Planning references: `agent/index.ts` ("Part IV" → "the point of this demo"), `scripts/derisk-revocation.ts:2`, `derisk-holder.ts:2`, `verify-live.ts:2`, `ard-adapter/index.ts:19-21` (`TODO(Phase 1.4)` → state what is missing: "Registry ingestion is not implemented: see spec/ADR-002"), `authorization-server.ts` "as before".
  - `server-view.ts:6-7` → "…for the revocation demo on a context continued with Run again in this context."
  - `web/server.ts:4-7`: "Discovery goes through the ARD registry when one is configured" → "Discovery crawls the publishers directly (registry ingestion is blocked upstream, spec/ADR-002)…".
  - `oauth-provider.ts:68` "Pre-registered" → "A fixed client id: the AS does not validate client ids and offers no dynamic registration."
- [ ] **Step 3:** `yarn typecheck && yarn test` → green; `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` → no errors.
- [ ] **Step 4: Commit** `chore(trust-lens): dead code and stale comments from the review`.

---

### Task 12: Docs and skills follow

**Files:** `README.md`, `docs/OPERATIONS.md`, `docs/ARCHITECTURE.md`, `docs/REVOCATION-AUDIT.md`, `.claude/skills/run-demo/SKILL.md`, `.claude/skills/troubleshoot/SKILL.md`, `.claude/skills/demo-walkthrough/SKILL.md`, `.env.example`

- [ ] **Step 1:**
  - DIDComm ports: remove `TRUST_LENS_DIDCOMM_PORT`/`TRUSTCO_CONSOLE_DIDCOMM_PORT` from README (env list, Path B paragraph), OPERATIONS port table, run-demo "Wallet link ports".
  - README "Forget authorizations" paragraph (~line 440): the step now goes Engage → complete → **Run again in this context** (no presentation asked) → revoke or Forget → Run again → asked again.
  - README/extension note on blocking A2A clients (9.11).
  - Audit vocabulary: README audit section and ARCHITECTURE "Authorization paths" — `engagement_refused / UNAVAILABLE` for outages, `authorization / step-up required` for a challenge.
  - troubleshoot: "after `yarn seed --reset` restart the Trust Lens" → no restart needed (if such a line exists); add symptom "`Authorization server unavailable — retrying`" → AS or Heka down, step-up kept.
  - REVOCATION-AUDIT: D4 (console stale seed state) → fixed by this change; note the AS pending TTL.
  - demo-walkthrough fault notes: publishers down now shows "Could not read: …" and an UNAVAILABLE verdict.
- [ ] **Step 2: Commit** `docs(trust-lens): docs and skills follow the review fixes`.

---

### Task 13: Validation (Q9) and final review

Stack per `run-demo`, Path A, from this checkout. Heka, the emulator and the wallet are already up and are not touched.

- [ ] **Step 1:** `yarn typecheck && yarn test` → green; `yarn verify:live` → `RESULT: PASS — the lookalike is refused, the genuine agent is usable`.
- [ ] **Step 2: Replay the review's fault scenarios** (all against services this session started):
  1. Stop `sites` → Discovery shows `Could not read: acme-invoices.example, acme-invoices-ai.example`; Verify all → `UNAVAILABLE` badges, old `VERIFIED` gone; Engage → 503, `/api/audit` has `engagement_refused · UNAVAILABLE`. Start `sites`.
  2. Engage MCP; `/api/mcp/call` sensitive → 401 step-up; stop `as` → `/api/mcp/authorization` → 503, step-up still pending, one `engagement_refused · UNAVAILABLE`; start `as` → poll → 410, step-up over, no `denial` in the audit.
  3. Engage the agent → `auth-required`; stop `agent` → task `failed`, audit `engagement_refused · UNAVAILABLE` (not `denial`). Start `agent`.
  4. Chat: stop `mcp` right after sending "Which invoices are held?" (after the tool list) → `error`; start `mcp`; ask again → an answer, no OpenAI 400.
  5. Start a second `yarn web` while the first runs → exits with `FATAL cannot listen on port 4000`.
- [ ] **Step 3: UI walk** in the built-in browser: Discovery → Verify all → Engage agent → Simulate → completed → **Run again in this context** → completes without a new presentation; Tasks, MCP (chat → step-up → Simulate → retried), Audit, Console, agent server view. Browser console: no errors.
- [ ] **Step 4: For the person (wallet):** Link wallet in the Trust Lens (inbound transport removed) → Send to wallet on a task → the Proof Request appears → Share → the task completes. Console → Send offer to wallet → the offer appears. If delivery fails, revert Task 8 step 2 to "start the transport at boot" (Q5 fallback).
- [ ] **Step 5: Final review** — one subagent (`superpowers:requesting-code-review`) over `175ecd7..HEAD`; fix Critical/Important.
- [ ] **Step 6:** Report: what was run, what it printed, what is the person's to check.
