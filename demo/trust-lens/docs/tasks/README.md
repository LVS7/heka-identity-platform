# Task briefs — Trust Lens improvements (September–October 2026)

Six pieces of work planned for the Trust Lens demo, one brief each (1–5 in September, 6 on
2026-10-01). A brief is what you hand to whoever does the work and what you check against
afterwards: why, what is wrong today (with evidence), what is in and out of scope, the decisions
already taken, a phased plan, a Definition of Done and the steps to validate it.

Briefs are deliberately **not** code-level plans. When a task starts, a code-level plan
(`superpowers:writing-plans`, saved under `docs/superpowers/plans/`) is derived from the brief.
The brief stays the source of truth for scope and acceptance; the plan is how.

## Order, branches and dependencies

The tasks are done **strictly one after another, in numeric order**, and each task's branch is
created from the **previous task's branch**, never from `litvinov-demo` directly (only task 1
starts there). A task starts only when the previous one meets its Definition of Done.

```
litvinov-demo
  └─ task/01-revocation
       └─ task/02-console-styling
            └─ task/03-presentation-ux
                 └─ task/04-agent-server-view
                      └─ task/05-mcp-llm-chat

litvinov-demo (T1–T5 squash-merged)
  └─ task/06-mcp-chat-authorization
```

So task 2 branches from `task/01-revocation`, task 3 from `task/02-console-styling`, and so on.
Every branch therefore already contains all earlier tasks; the last column names what a task
actually builds on. Task 6 was added after T1–T5 were merged into `litvinov-demo`, so it
branches from there.

| #   | Brief                                                            | Branch                       | Branches from                | Builds on                                                                             |
| --- | ---------------------------------------------------------------- | ---------------------------- | ---------------------------- | ------------------------------------------------------------------------------------- |
| 1   | [Revocation double-check](01-revocation-double-check.md)         | `task/01-revocation`         | `litvinov-demo`              | the housekeeping commit; produces the presented-credential module that 3, 4, 5 reuse |
| 2   | [Console styling](02-console-styling.md)                         | `task/02-console-styling`    | `task/01-revocation`         | 1's console journal (Activity tab); extracts `ui.js` that 3 and 4 use                |
| 3   | [Presentation in engagements](03-presentation-in-engagements.md) | `task/03-presentation-ux`    | `task/02-console-styling`    | 1's `PresentedCredential` / `StatusCheck`, 2's `ui.js`                                |
| 4   | [Agent server view](04-agent-server-view.md)                     | `task/04-agent-server-view`  | `task/03-presentation-ux`    | 1's types, 2's `ui.js`, what 3 makes the agent record                                 |
| 5   | [MCP LLM chat](05-mcp-llm-chat.md)                               | `task/05-mcp-llm-chat`       | `task/04-agent-server-view`  | 1's engage preflight and Drop token, 3's step-up panel and presentation card          |
| 6   | [MCP chat authorization](06-mcp-chat-authorization.md)            | `task/06-mcp-chat-authorization` | `litvinov-demo`            | T1–T5 merged into `litvinov-demo`; fixes T5's chat so it reaches the step-up        |

## Conventions for every task

- One branch per task, named `task/0N-<slug>`, created from the previous task's branch as shown
  above (task 1 from `litvinov-demo`); one commit per plan step; commit messages carry the
  reasoning. Do not start task N+1 before task N's Definition of Done is met.
- **Housekeeping first.** Before task 1 starts, commit the untracked files that committed code
  already imports: `src/shared/wallet-link.ts`, `src/shared/wallet-link-credo.ts`,
  `src/shared/officer-offer.ts`, `src/web/wallet-delivery.ts`, `src/web/public/vendor/`.
  A task branch cannot build without them. In the reference demo, commit
  `demo/a2a-oid4vp/docker-compose.demo.yml` (its `TECH-DEBT.md` asks for it) and never commit
  `demo/a2a-oid4vp/.env` — it holds the OpenAI key and the Heka token; add an ignore rule for it.
- English throughout; `src/core` stays dependency-light (Node built-ins only); comments say _why_
  (see `CLAUDE.md`).
- Global Definition of Done, implied by every brief:
  - [ ] `yarn typecheck` passes, with no `// @ts-expect-error` added
  - [ ] `yarn test` passes; new behaviour has a unit test wherever the code is injectable
  - [ ] `yarn verify:live` ends with `RESULT: PASS — the lookalike is refused, the genuine agent is usable`
  - [ ] README / `docs/` / `.claude/skills` updated where the brief lists them; the
        `ENHANCEMENTS.md` entry a task closes is removed from that file
  - [ ] the seven invariants in `CLAUDE.md` hold; if a change seems to need breaking one, stop
        and say so instead of working around it
- Validation is written for **Path A** (services on the host with `yarn <service>`, Heka in
  Docker). Path B differences are called out where a container name matters.
- Wallet steps belong to the person: the PIN, **Accept**, **Share**. No validation step
  automates the phone and none uses `adb`. Use the simulated holder for the quick pass and the
  real Heka Wallet for the final one.

## Facts every brief relies on

- The A2A In-Task Auth extension spec (`v1/spec.md`) defines nothing after verification: no
  result, no disclosed claims, no session id. Anything the agent returns to the client about the
  presentation is a demo addition and is labelled as such in code and docs.
- Heka's `GET /openid4vc/verification-session/:id` returns `sharedAttributes` (all SD-JWT claims
  minus `vct`, `cnf`, `iss`, `iat`) and `authorizationResponsePayload` (carrying `vp_token`) once
  the session is `ResponseVerified`. `credentialStatus` is a non-SD claim, so it is present in
  `sharedAttributes`; `iss` and `cnf` are not, so issuer and holder need the `vp_token` decoded.
- Heka's verifier does not constrain the issuer of a presented credential — there is no
  trusted-issuer setting anywhere in `heka-identity-service/src`. The relying party has to check
  `iss` itself.
- `@modelcontextprotocol/sdk` 1.30.0 is installed and imported by nothing. Its Streamable HTTP
  client handles 401/403 only when an `OAuthClientProvider` is supplied; without one it throws a
  bare `StreamableHTTPError` and never reads `WWW-Authenticate`.
- Genkit 1.41.0 with `@genkit-ai/compat-oai` is installed; `demo/a2a-oid4vp/.env` carries a
  non-placeholder `OPENAI_API_KEY` (reused for task 5, never committed).
- The stack runs on the host (Path A); `.logs/*.log` are host process logs. Only Heka is in Docker.
