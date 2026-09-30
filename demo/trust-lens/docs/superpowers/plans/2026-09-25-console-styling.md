# T2 — TrustCo Console styling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the TrustCo Console look and behave like part of the same product as the Trust Lens: shared helpers and stylesheet, no inline styles, header parity, inline errors, an offer panel with a QR, and an Activity tab over the console's journal.

**Architecture:** UI helpers that both pages copy today move into `src/web/public/ui.js`, served to the console through the existing `/shared` mount. `app.css` gains a handful of shared rules (`h2`, `:focus-visible`, `.danger`, `.panel`, `.role-chip`, a 720 px breakpoint). The console page is rewritten on the shared classes; `console.js` is rewritten around one `load()` that reads wallet and credentials together, plus an Activity view polling `GET /api/audit` (from T1).

**Tech Stack:** Vanilla browser JS and CSS (no build step, no new dependency), Express 5 (one new route), the vendored `qrcode-generator`.

**Brief:** `docs/tasks/02-console-styling.md` is the source of truth for scope, DoD and validation. One deliberate refinement of the brief: the officer tile's offer button stays enabled without a wallet link and reads **Mint offer (QR)**, so the README's promise ("shown for a phone that would rather scan it") holds; with a link it reads **Send offer to wallet**.

## Global Constraints

- English throughout — code, comments, docs, commit messages. Comments explain _why_.
- Both UIs stay vanilla and dependency-free: no modules, no bundler, no framework; `ui.js` is a plain script that sets `window.ui`.
- Prettier: `printWidth: 120`, no semicolons, single quotes, `arrowParens: always`, trailing commas `es5`, LF. Run `yarn prettier --check` on every file touched (`--write` to fix).
- No palette change: the eleven `:root` variables in `app.css` are not edited (decision Q8/Q25). The console is told apart by a chip reading `Issuer`, not by colour.
- The Trust Lens must look and behave exactly as before, except for the shared fixes named in Task 2 (heading size, centred `main`, focus rings).
- `yarn typecheck` and `yarn test` must stay green; `node --check` on every changed browser script.
- Work from `demo/trust-lens`; commits on `task/02-console-styling`; commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; use `git -c core.safecrlf=false commit` if git complains about CRLF.
- The demo services run on the host and belong to the operator: do not start, stop or restart them. Browser checks happen after the operator restarts `yarn web` and `yarn console`; until then verification is static (`node --check`, prettier, grep).

---

### Task 1: Shared UI helpers (`src/web/public/ui.js`)

**Files:**

- Create: `src/web/public/ui.js`
- Modify: `src/web/public/app.js` (lines 5-14, 24-36, 228-233, 255, 299-306, 328, ~601), `src/web/public/index.html:142-143`
- Modify: `src/console/public/index.html:96` (script tags), `src/console/public/console.js:3-8, 48-55`

**Interfaces:**

- Produces `window.ui = { el, escapeHtml, renderQr, formatWhen, renderWalletChip, copyText }`:
  - `el(id) → HTMLElement | null`
  - `escapeHtml(value) → string`
  - `renderQr(target, text)` — SVG QR into `target` (needs `qrcode-generator` loaded first)
  - `formatWhen(iso) → string` — `new Date(iso).toLocaleTimeString()`
  - `renderWalletChip({ chipId, inputId, linkId, unlinkId? }, wallet)` — the chip/input/buttons state
  - `copyText(text, button?) → Promise<void>` — clipboard write; flips the button label to `Copied` for 1.2 s

- [ ] **Step 1: Create `ui.js`**

```js
/*
 * UI helpers shared by the Trust Lens and the TrustCo Console.
 *
 * Both pages are static, dependency-free files (one vendored QR encoder), so this is a plain
 * script that sets a global rather than a module: the console loads it through the Trust Lens's
 * `/shared` mount and must not need a bundler to do so.
 */

window.ui = (() => {
  const el = (id) => document.getElementById(id)

  const escapeHtml = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    )

  /** SVG QR of `text` into `target`. Requires vendor/qrcode-generator.js to be loaded first. */
  function renderQr(target, text) {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    target.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true })
  }

  const formatWhen = (iso) => new Date(iso).toLocaleTimeString()

  /**
   * The wallet-link widget in the header: a chip, the DID input, Link and (optionally) Unlink.
   * Both UIs share the link file, so both render it the same way.
   */
  function renderWalletChip(ids, wallet) {
    const { linked, holderDid, source } = wallet
    const chip = el(ids.chipId)
    chip.className = `badge ${linked ? 'ok' : ''}`
    chip.textContent = linked ? `wallet: linked · ${holderDid.slice(0, 22)}…` : 'wallet: not linked'
    chip.title = linked ? `${holderDid}${source === 'env' ? ' (from HOLDER_PUBLIC_DID)' : ''}` : ''
    el(ids.inputId).hidden = linked
    el(ids.linkId).hidden = linked
    if (ids.unlinkId) el(ids.unlinkId).hidden = !linked
  }

  /** Copy to the clipboard; on http origins the browser may refuse, and the text is selectable anyway. */
  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      return
    }
    if (!button) return
    const label = button.textContent
    button.textContent = 'Copied'
    setTimeout(() => {
      button.textContent = label
    }, 1200)
  }

  return { el, escapeHtml, renderQr, formatWhen, renderWalletChip, copyText }
})()
```

- [ ] **Step 2: Use it from `app.js`**

Read `src/web/public/app.js` first. Then:

- Replace lines 5-10 (`const el = …` and the `escapeHtml` arrow) with `const { el, escapeHtml } = ui`.
- Replace the body of `renderWallet` (lines 24-36) with:

```js
function renderWallet() {
  ui.renderWalletChip(
    { chipId: 'wallet-chip', inputId: 'wallet-did', linkId: 'wallet-link', unlinkId: 'wallet-unlink' },
    state.wallet
  )
  // The send buttons depend on the link; re-render whichever panel is open.
  renderSendButton('task')
  renderSendButton('mcp')
}
```

- Delete `function renderQr(target, text) { … }` (lines 228-233); change the call at line 269 to `ui.renderQr(el(\`${panel}-qr\`), request)`.
- Delete `async function copyUri(sourceId) { … }` (lines 299-306); change the listener at line ~601 to `if (copy) ui.copyText(el(copy.dataset.copy).textContent, copy)`.
- Replace both `new Date(...).toLocaleTimeString()` expressions (lines 255 and 328) with `ui.formatWhen(...)` of the same argument.
- `grep -n "toLocaleTimeString\|function renderQr\|function copyUri\|^const el\|^const escapeHtml" src/web/public/app.js` must print nothing.

`src/web/public/index.html:142-143` becomes:

<!-- prettier-ignore -->
```html
    <script src="./vendor/qrcode-generator.js"></script>
    <script src="./ui.js"></script>
    <script src="./app.js"></script>
```

- [ ] **Step 3: Use it from the console (behaviour unchanged for now)**

`src/console/public/console.js`: replace lines 3-8 with `const { el, escapeHtml } = ui`; replace `renderWallet` (lines 48-55) with

```js
function renderWallet() {
  ui.renderWalletChip({ chipId: 'wallet-chip', inputId: 'wallet-did', linkId: 'wallet-link' }, wallet)
}
```

`src/console/public/index.html:96` becomes:

<!-- prettier-ignore -->
```html
    <script src="./shared/vendor/qrcode-generator.js"></script>
    <script src="./shared/ui.js"></script>
    <script src="./console.js"></script>
```

- [ ] **Step 4: Static checks**

Run: `node --check src/web/public/ui.js && node --check src/web/public/app.js && node --check src/console/public/console.js`
Run: `yarn prettier --check src/web/public/ui.js src/web/public/app.js src/web/public/index.html src/console/public/console.js src/console/public/index.html`
Run: `yarn typecheck && yarn test` (unchanged: 72 tests)
Run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4100/shared/ui.js` — prints `200` (the running console serves `/shared` from disk; no restart needed for this check).

- [ ] **Step 5: Commit**

```bash
git add src/web/public/ui.js src/web/public/app.js src/web/public/index.html src/console/public/console.js src/console/public/index.html
git commit -m "refactor(ui): one set of helpers for both pages

el, escapeHtml, the QR renderer, the wallet chip and clipboard copy were pasted between the
Trust Lens and the console. One plain script, served to the console through /shared.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Shared stylesheet fixes (`src/web/public/app.css`)

**Files:**

- Modify: `src/web/public/app.css` (add rules; delete `.auth-row` at 366-372 and `#auth-qr` at 374-379; generalise `.delivery` at 484-495)

**Interfaces:** new classes `button.danger`, `.panel`, `.panel h3`, `.role-chip`, `.delivery{,.sent,.failed}` (no longer scoped to `.auth-way`), plus `h2`, `:focus-visible`, centred `main`, `@media (max-width: 720px)`.

- [ ] **Step 1: Edit `app.css`**

After the `.subtitle` rule (line 53) add:

```css
/* View headings sit under the 21px h1; without a rule they fell back to the browser's 1.5em. */
h2 {
  margin: 0 0 6px;
  font-size: 18px;
}

/* Keyboard users need to see where they are; nothing in the palette changes. */
button:focus-visible,
input:focus-visible,
.tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* The console marks itself as the issuer with a chip, not with a different palette. */
.role-chip {
  display: inline-block;
  vertical-align: middle;
  margin-left: 8px;
  border: 1px solid var(--accent);
  border-radius: 999px;
  padding: 1px 9px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--accent);
}
```

Change `main` (lines 76-79) to include `margin: 0 auto;`.

After the `#verify-all` rule (line 128) add:

```css
/* Destructive actions look different from the rest; the revoke switch is the one the audience watches. */
button.danger {
  border-color: rgba(248, 113, 113, 0.6);
  color: var(--bad);
}

button.danger:hover:not(:disabled) {
  border-color: var(--bad);
  background: rgba(248, 113, 113, 0.08);
}
```

After the `.refusal` rule (line 245) add:

```css
/* A titled container for a block of related facts (the issuer's details, an offer). */
.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 16px 18px;
  margin-top: 20px;
}

.panel h3 {
  margin: 0 0 10px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}

.panel .kv {
  margin-top: 0;
}
```

Delete the `.auth-row` rule (lines 366-372) and the `#auth-qr` rule (lines 374-379) — both are dead.

Replace the three `.auth-way .delivery…` rules (lines 484-495) with rules that work anywhere:

```css
.delivery {
  margin-top: 8px;
  font-size: 12.5px;
  color: var(--muted);
}

.delivery.sent {
  color: var(--ok);
}

.delivery.failed {
  color: var(--bad);
}
```

Append at the end of the file:

```css
/* ---------- small screens ---------- */

@media (max-width: 720px) {
  header {
    flex-direction: column;
    align-items: stretch;
    gap: 14px;
  }

  .auth-ways,
  .card {
    grid-template-columns: 1fr;
  }

  .right {
    align-items: flex-start;
  }

  .kv div {
    grid-template-columns: 1fr;
    gap: 2px;
  }

  .wallet input {
    min-width: 0;
    width: 100%;
  }
}
```

- [ ] **Step 2: Checks**

Run: `yarn prettier --check src/web/public/app.css`
Run: `grep -n "auth-row\|#auth-qr" src/web/public/app.css src/web/public/index.html src/web/public/app.js` — prints nothing.
Run: `grep -c ":root" src/web/public/app.css` — `1`, and `git diff src/web/public/app.css | grep -E "^[-+] +--" ` prints nothing (no variable touched).

- [ ] **Step 3: Commit**

```bash
git add src/web/public/app.css
git commit -m "style(ui): shared rules both pages were missing

A rule for plain h2 (view headings rendered larger than the h1), focus rings, a danger button,
a titled panel, the issuer chip, centred content, one breakpoint, and two dead rules removed.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The console on the shared classes

**Files:**

- Modify: `src/console/server.ts` (add `DELETE /api/wallet/link` after `POST /api/wallet/link`)
- Rewrite: `src/console/public/index.html`, `src/console/public/console.js`
- Modify: `src/web/public/app.css` (three small console-specific rules, appended)

**Interfaces:**

- Consumes: `window.ui` (Task 1), `.panel`/`.danger`/`.role-chip`/`.delivery` (Task 2), `GET /api/audit` (T1-C3), `GET /api/credentials`, `GET /api/wallet`, `POST /api/wallet/link`, `POST /api/credentials/officer/offer`, `POST /api/credentials/:key/status`.
- Produces: `DELETE /api/wallet/link → WalletLinkStatus`; the console page with views `credentials` and `activity`.

- [ ] **Step 1: The unlink route**

In `src/console/server.ts`, after the `POST /api/wallet/link` route add:

<!-- prettier-ignore -->
```ts
  app.delete('/api/wallet/link', async (_req, res) => {
    await walletLink.unlink()
    res.json(walletLink.status)
  })
```

- [ ] **Step 2: Rewrite `src/console/public/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TrustCo Console</title>
    <link rel="stylesheet" href="./shared/app.css" />
  </head>
  <body>
    <header>
      <div class="brand">
        <h1>TrustCo Console <span class="role-chip">Issuer</span></h1>
        <p class="subtitle">Certification body · issues Resource Passports and the officer role credential</p>
      </div>
      <div class="wallet" id="wallet">
        <span class="badge" id="wallet-chip">wallet: not linked</span>
        <input
          id="wallet-did"
          type="text"
          placeholder="did:peer:2… (the wallet’s Public DID)"
          aria-label="Wallet public DID"
        />
        <button id="wallet-link">Link wallet</button>
        <button id="wallet-unlink" hidden>Unlink</button>
        <span class="error" id="wallet-error"></span>
      </div>
      <nav>
        <button class="tab active" data-view="credentials">Credentials</button>
        <button class="tab" data-view="activity">Activity</button>
      </nav>
    </header>

    <main>
      <section id="credentials" class="view active">
        <h2>Credentials</h2>
        <p class="note">
          Revoking here updates the published status list; every relying party — the Trust Lens, the agent, the
          authorization server — reads it on its next check. Nothing is republished and the registry is not involved.
          <strong>Send offer to wallet</strong> issues the operator’s Finance Data Officer credential over DIDComm;
          without a linked wallet the offer is shown as a QR instead.
        </p>
        <p class="failure" id="load-error" hidden></p>

        <div id="tiles" class="cards"></div>
        <p class="note" id="updated"></p>

        <div class="panel" id="issuer">
          <h3>Issuer</h3>
          <div class="kv" id="issuer-kv"></div>
        </div>
      </section>

      <section id="activity" class="view">
        <h2>Activity</h2>
        <p class="note">What this issuer did, newest first: revocations, restores and credential offers.</p>
        <ol id="activity-list" class="timeline"></ol>
      </section>
    </main>

    <script src="./shared/vendor/qrcode-generator.js"></script>
    <script src="./shared/ui.js"></script>
    <script src="./console.js"></script>
  </body>
</html>
```

- [ ] **Step 3: Rewrite `src/console/public/console.js`**

```js
/* TrustCo Console — the issuer's side: three credentials with a revoke switch each, the officer offer, and a journal. */

const { el, escapeHtml } = ui

let wallet = { linked: false }
let minting = false
/** The last minted offer, kept across the 5 s re-render so the QR does not vanish under the operator. */
let lastOffer = null
let activityPoll = null

const KIND = { officer: 'role credential', acmeAgent: 'resource passport', acmeMcp: 'resource passport' }

// ---------- credentials ----------

function renderTiles(credentials) {
  el('tiles').innerHTML = credentials
    .map(
      (credential) => `
        <article class="card ${credential.revoked ? 'refused' : ''}">
          <div>
            <h3>${escapeHtml(credential.title)}</h3>
            <div class="meta">
              <span>${escapeHtml(credential.subtitle)}</span>
              <span class="chip">${escapeHtml(KIND[credential.key] ?? 'credential')}</span>
              <span class="chip">status index ${escapeHtml(credential.statusListIndex)}</span>
            </div>
          </div>
          <div class="right">
            <span class="badge ${credential.revoked ? 'bad' : 'ok'}">${credential.revoked ? 'REVOKED' : 'ACTIVE'}</span>
            <div class="actions">
              ${
                credential.key === 'officer'
                  ? `<button class="auth-primary" data-offer="officer">${wallet.linked ? 'Send offer to wallet' : 'Mint offer (QR)'}</button>`
                  : ''
              }
              <button class="${credential.revoked ? '' : 'danger'}" data-key="${escapeHtml(credential.key)}" data-revoke="${credential.revoked ? 'false' : 'true'}">
                ${credential.revoked ? 'Restore' : 'Revoke'}
              </button>
            </div>
          </div>
          <p class="desc">${escapeHtml(credential.effect)}</p>
          ${
            credential.key === 'officer' && !wallet.linked
              ? '<p class="note">No wallet linked: the offer is minted and shown as a QR for a phone with a camera. Link the wallet to push it over DIDComm.</p>'
              : ''
          }
          <p class="refusal" id="error-${escapeHtml(credential.key)}"></p>
          ${credential.key === 'officer' ? '<div class="offer-slot" id="offer-note"></div>' : ''}
        </article>`
    )
    .join('')
  renderOffer()
}

function renderOffer() {
  const box = el('offer-note')
  if (!box || !lastOffer) return

  const status = lastOffer.error
    ? `<div class="delivery failed">Delivery failed: ${escapeHtml(lastOffer.error)}</div>`
    : lastOffer.delivered
      ? '<div class="delivery sent">Offer delivered to the operator’s wallet over DIDComm — the person taps <strong>Accept</strong> there.</div>'
      : `<div class="delivery">${escapeHtml(lastOffer.note ?? 'Offer minted — scan it with Heka Wallet.')}</div>`

  box.innerHTML = `
    <div class="panel offer">
      <h3>Credential offer</h3>
      ${status}
      <div class="offer-body">
        <div class="qr" id="offer-qr" aria-label="Credential offer QR code"></div>
        <div class="offer-text">
          <div class="uri"><code id="offer-uri"></code><button data-copy="offer-uri">Copy</button></div>
          <p class="note">The offer is single-use. Mint another for a second device or after the wallet is reset.</p>
        </div>
      </div>
    </div>`
  el('offer-uri').textContent = lastOffer.offer
  ui.renderQr(el('offer-qr'), lastOffer.offer)
}

function renderIssuer(data) {
  el('issuer-kv').innerHTML = [
    ['Issuer', `${data.issuer.name} (${data.issuer.legalName})`],
    ['Issuer DID', data.issuer.did],
    ['Status list', data.statusList],
  ]
    .map(([label, value]) => `<div><span>${escapeHtml(label)}</span><code>${escapeHtml(value)}</code></div>`)
    .join('')
}

// ---------- wallet ----------

function renderWallet() {
  ui.renderWalletChip(
    { chipId: 'wallet-chip', inputId: 'wallet-did', linkId: 'wallet-link', unlinkId: 'wallet-unlink' },
    wallet
  )
}

async function linkWallet() {
  el('wallet-error').textContent = ''
  el('wallet-link').disabled = true
  el('wallet-link').textContent = 'Linking…'

  try {
    const response = await fetch('/api/wallet/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ holderDid: el('wallet-did').value.trim() }),
    })
    const data = await response.json()
    if (!response.ok) {
      el('wallet-error').textContent = data.error
      return
    }
    wallet = data
    renderWallet()
    load()
  } finally {
    el('wallet-link').disabled = false
    el('wallet-link').textContent = 'Link wallet'
  }
}

async function unlinkWallet() {
  const response = await fetch('/api/wallet/link', { method: 'DELETE' })
  wallet = response.ok ? await response.json() : { linked: false }
  renderWallet()
  load()
}

// ---------- loading ----------

/** Wallet and credentials together: a link made in the Trust Lens shows here within one poll. */
async function load() {
  if (minting) return // do not swap the button out from under an in-flight request

  try {
    const [walletResponse, response] = await Promise.all([fetch('/api/wallet'), fetch('/api/credentials')])
    wallet = walletResponse.ok ? await walletResponse.json() : { linked: false }
    renderWallet()

    const data = await response.json()
    if (!response.ok) throw new Error(data.error)

    renderTiles(data.credentials)
    renderIssuer(data)
    el('load-error').hidden = true
    el('updated').textContent = `updated ${ui.formatWhen(new Date().toISOString())}`
  } catch (error) {
    el('load-error').hidden = false
    el('load-error').textContent = `Could not read the issuer state: ${error.message}`
  }
}

async function sendOffer(button) {
  minting = true
  button.disabled = true
  const label = button.textContent
  button.textContent = 'Minting…'

  try {
    const response = await fetch('/api/credentials/officer/offer', { method: 'POST' })
    const data = await response.json()
    if (!response.ok && !data.offer) {
      lastOffer = null
      el('error-officer').textContent = data.error
      return
    }
    el('error-officer').textContent = ''
    lastOffer = { offer: data.offer, delivered: Boolean(data.delivered), error: data.error, note: data.note }
    renderOffer()
  } finally {
    minting = false
    button.disabled = false
    button.textContent = label
  }
}

async function toggleRevocation(button) {
  const key = button.dataset.key
  button.disabled = true
  const label = button.textContent
  button.textContent = '…'

  try {
    const response = await fetch(`/api/credentials/${key}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revoked: button.dataset.revoke === 'true' }),
    })
    const data = await response.json()
    if (response.ok) {
      renderTiles(data.credentials)
      if (el('activity').classList.contains('active')) loadActivity()
    } else {
      button.textContent = label
      el(`error-${key}`).textContent = data.error
    }
  } finally {
    button.disabled = false
  }
}

// ---------- activity ----------

function renderEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return ''
  const rows = Object.entries(evidence)
    .filter(([, value]) => value !== undefined && typeof value !== 'object')
    .map(([key, value]) => `<div><span>${escapeHtml(key)}</span><code>${escapeHtml(String(value))}</code></div>`)
    .join('')
  return rows ? `<div class="kv compact">${rows}</div>` : ''
}

async function loadActivity() {
  const response = await fetch('/api/audit')
  const data = await response.json()

  // A revocation is the decision the audience came to see; colour it by what happened.
  const tone = (event) => (event.type === 'revocation' ? (event.outcome === 'REVOKED' ? 'bad' : 'ok') : '')

  el('activity-list').innerHTML =
    (data.events ?? [])
      .map(
        (event) => `<li class="${tone(event)}">
          <div class="when">${escapeHtml(ui.formatWhen(event.timestamp))} · ${escapeHtml(event.type)}</div>
          <strong>${escapeHtml(event.subject)}</strong> — ${escapeHtml(event.outcome)}
          ${renderEvidence(event.evidence)}
        </li>`
      )
      .join('') || '<li class="note">Nothing recorded yet.</li>'
}

// ---------- views ----------

function showView(name) {
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === name))
  document
    .querySelectorAll('.tab[data-view]')
    .forEach((tab) => tab.classList.toggle('active', tab.dataset.view === name))

  clearInterval(activityPoll)
  activityPoll = null
  if (name === 'activity') {
    loadActivity()
    activityPoll = setInterval(loadActivity, 5000)
  }
}

// ---------- wiring ----------

el('tiles').addEventListener('click', (event) => {
  const offer = event.target.closest('[data-offer]')
  if (offer) return sendOffer(offer)

  const copy = event.target.closest('[data-copy]')
  if (copy) return ui.copyText(el(copy.dataset.copy).textContent, copy)

  const button = event.target.closest('[data-key]')
  if (button) toggleRevocation(button)
})

el('wallet-link').addEventListener('click', linkWallet)
el('wallet-unlink').addEventListener('click', unlinkWallet)
el('wallet-did').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') linkWallet()
})

document.querySelectorAll('.tab[data-view]').forEach((tab) => {
  tab.addEventListener('click', () => showView(tab.dataset.view))
})

load()
setInterval(load, 5000)
```

- [ ] **Step 4: Three console-specific rules**

Append to `src/web/public/app.css` (before the `@media` block):

```css
/* ---------- console: the offer panel and compact evidence ---------- */

.panel.offer {
  margin-top: 8px;
}

.offer-body {
  display: flex;
  gap: 18px;
  align-items: flex-start;
  margin-top: 10px;
}

.offer-text {
  flex: 1;
  min-width: 0;
}

.kv.compact {
  margin-top: 8px;
  gap: 4px;
}
```

and inside the `@media (max-width: 720px)` block add `.offer-body { flex-direction: column; }`.

- [ ] **Step 5: Static checks**

Run: `node --check src/console/public/console.js`
Run: `yarn prettier --check src/console/server.ts src/console/public/console.js src/console/public/index.html src/web/public/app.css`
Run: `yarn typecheck && yarn test`
Run: `grep -c "<style" src/console/public/index.html` → `0`; `grep -c "alert(" src/console/public/console.js` → `0`.
Run: `curl -s -X DELETE http://localhost:4100/api/wallet/link` — against the running (old) console this is 404 until the operator restarts; note it in the report rather than restarting.

- [ ] **Step 6: Commit**

```bash
git add src/console/server.ts src/console/public/index.html src/console/public/console.js src/web/public/app.css
git commit -m "feat(console): the issuer's page on the shared components

No inline stylesheet; cards, chips, a danger switch and a titled issuer panel from app.css; the
offer becomes a panel with a QR and a Copy button; wallet link, Unlink and Linking… as in the
Trust Lens; errors inline instead of alert(); an Activity tab over the console's journal.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Docs

**Files:**

- Modify: `README.md:586` (components table row), `docs/ARCHITECTURE.md:131` (layout line for `web/`), `.claude/skills/wallet-flow/SKILL.md:96-98`

- [ ] **Step 1: Edit**

`README.md:586`: the TrustCo Console row's description becomes `issuer's credential tiles and revoke switches, the officer offer as a QR, and an activity journal`.

`docs/ARCHITECTURE.md:131`: `  web/          Trust Lens: discovery, verification, A2A task tracking, MCP client, static UI (ui.js and app.css are shared with the console)`.

`.claude/skills/wallet-flow/SKILL.md:96-98`: after the sentence ending `…the person taps Accept (scroll down; it sits below Decline).` add: `Without a linked wallet the same button reads **Mint offer (QR)** and the console shows the offer as a QR for a phone with a camera.` (keep the paragraph's wrapping).

- [ ] **Step 2: Check and commit**

Run: `yarn prettier --check README.md docs/ARCHITECTURE.md .claude/skills/wallet-flow/SKILL.md`

```bash
git add README.md docs/ARCHITECTURE.md .claude/skills/wallet-flow/SKILL.md
git commit -m "docs: the console has a QR, an activity tab and shares ui.js

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## After the last task (controller)

1. Final whole-branch review (superpowers:requesting-code-review).
2. Ask the operator to restart `yarn web` and `yarn console`, then run the brief's **Steps to validate** 1–8 (browser checks through the built-in browser; curl checks directly) and record the outcomes in `.superpowers/sdd/progress.md`.
3. Keep the branch; T3 branches from it.
