# T2 — TrustCo Console: improve styling

> Status: done · Branch: `task/02-console-styling` from `task/01-revocation` (second in
> the chain; T1 must meet its DoD first) · Builds on: T1-C3 (`GET /api/audit` on the console) for
> phase 5; phases 1–4 need nothing from T1 · Next in the chain: `task/03-presentation-ux` branches
> from this one

## Why

The console is the issuer's face in the demo and the place where the kill switch is pulled in
front of an audience. It already loads the Trust Lens stylesheet but re-implements its components
inline, lacks half of the header, shows errors with `alert()`, and promises a QR it does not
render. The task of restyling the console serves the following goals:

- the console looks like part of the same product as the Trust Lens, on the shared stylesheet
- one set of UI helpers serves both pages (and the agent's page in T4)
- failures are shown inline, and the credential offer is scannable as a QR
- the issuer's own activity — revocations, restores, offers — is visible on the page

## Findings

- `src/console/public/index.html:7` links `./shared/app.css`; `src/console/server.ts:99-100`
  serves `src/web/public` under `/shared`. Palette, fonts, header and badges are shared already.
- `index.html:8-59` is an inline `<style>` that copies `.card` as `.tile` (with `align-items`,
  `h3` size and border alpha slightly off), `.kv` as `.issuer`, `.desc` as `.effect`, and defines
  `.offer-note .ok/.bad`.
- Header (`index.html:62-78`): no `<nav>`, no Unlink (and no `DELETE /api/wallet/link` route in
  `server.ts`), no "Linking…" state (`console.js:63-78`); wallet status is loaded once and never
  polled (`console.js:157`).
- Tiles (`console.js:13-36`): `.meta` holds only the subtitle; Revoke, Restore and Send offer
  share the base button; Send offer is not disabled when no wallet is linked, only titled.
- Offer result (`console.js:110-116`): a coloured span, the bare URI in `.uri`, no Copy, no QR.
  README says the offer "is also shown under the tile for a phone that would rather scan it".
- Errors: `load()` has no try/catch (`console.js:80-92`); a failed revoke calls `alert()`
  (`console.js:145`).
- Shared weaknesses in `src/web/public/app.css`: no rule for a plain `h2` (view headings render
  at the browser default 22.5 px, larger than the 21 px `h1`), no `:focus-visible`, no `@media`
  breakpoints, `main` not centred, dead rules `.auth-row` and `#auth-qr` (`app.css:366-379`),
  `.brand` unstyled.
- `demo/a2a-oid4vp` has no web UI. Heka's own web UI is a light Inter/brown system unrelated to
  the Trust Lens palette. No Figma or screenshot reference exists.
- `el()` and `escapeHtml()` are copy-pasted between `app.js` and `console.js`; QR rendering
  (`renderQr`, `app.js:228-233`) exists only in the Trust Lens.

## Scope

1. Shared UI helpers extracted once and used by both UIs (and by T4's page).
2. Shared `app.css` fixes that improve both UIs.
3. Console markup and components on the shared classes; no inline stylesheet.
4. Console behaviour: header parity, inline errors, wallet polling, offer result with QR and Copy.
5. Activity tab over the console journal (after T1-C3).

### Non-goals

- Re-theming to Heka branding or any palette change (decisions Q8 and Q25: no reference, no
  invention).
- A build step, a framework, or any new dependency — both UIs stay vanilla and dependency-free.
- New issuer capabilities (issuing other credentials, editing the trust list).

## Decisions (design review)

1. The target look is parity with the Trust Lens over the shared stylesheet. The console is told
   apart by a chip reading `Issuer` in the header and by its subtitle, not by colour.
2. Phases 1–4 are mandatory; phase 5 (Activity) is cheap once T1 provides `GET /api/audit` and
   is done last.
3. Shared helpers live in `src/web/public/ui.js` and reach the console through `/shared/ui.js`.

## Plan

### Phase 1 — shared helpers (`src/web/public/ui.js`)

Move out of `app.js` and `console.js`, unchanged in behaviour, as plain globals (no modules; the
pages are static and dependency-free):

```js
window.ui = {
  el,               // (id) => element
  escapeHtml,       // (value) => string
  renderQr,         // (target, text) — qrcode-generator, SVG, exactly app.js:228-233 today
  formatWhen,       // (iso) => 'hh:mm:ss' local time
  renderWalletChip, // ({ chipId, inputId, linkId, unlinkId, errorId }, wallet) — the app.js:24-36 logic
  copyText,         // (text, button) — the app.js copyUri feedback ('Copied')
}
```

The web `index.html` loads `vendor/qrcode-generator.js`, `ui.js`, `app.js`; the console loads
`/shared/vendor/qrcode-generator.js`, `/shared/ui.js`, `console.js`. `app.js` and `console.js`
drop their local copies. The Trust Lens must look and behave exactly as before after this phase.

### Phase 2 — shared stylesheet fixes (`src/web/public/app.css`)

- `h2 { font-size: 18px; margin: 0 0 6px }` (matches `.drawer h2`) so view headings sit under `h1`.
- `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }` on buttons, tabs, inputs.
- `button.danger` — a `--bad` outline variant mirroring `.auth-primary` (`app.css:497`); hover
  fills with `rgba(248,113,113,.08)`.
- `.panel` — a titled container: `background: var(--panel); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 16px 18px`, with `.panel h3` at 14 px, muted, uppercase.
- `.role-chip` — the Issuer marker next to `h1`: `.chip` sized to the heading, `--accent` border.
- `main { margin: 0 auto }` (keeps `max-width: 1080px`).
- `@media (max-width: 720px)`: `header` stacks (`flex-direction: column; align-items: stretch`),
  `.auth-ways` and `.card` become one column, `.kv` becomes `grid-template-columns: 1fr`,
  `.wallet input { min-width: 0; width: 100% }`.
- Delete `.auth-row` and `#auth-qr`.

### Phase 3 — console markup (`src/console/public/index.html`)

- Remove the inline `<style>`.
- Header: `.brand` gets `<h1>TrustCo Console <span class="role-chip">Issuer</span></h1>` and the
  subtitle `Certification body · issues Resource Passports and the officer role credential`; the
  wallet widget gains `<button id="wallet-unlink" hidden>Unlink</button>`; a `<nav>` with the tabs
  `Credentials` (active) and `Activity`.
- `<main>`: `<section id="credentials" class="view active">` with `<h2>Credentials</h2>`, one
  intro `.note` (the two current paragraphs merged), `#tiles.cards`, then
  `<div class="panel" id="issuer"><h3>Issuer</h3><div class="kv" id="issuer-kv"></div></div>`;
  `<section id="activity" class="view">` with `<h2>Activity</h2>`, a `.note` and
  `<ol id="activity-list" class="timeline">`.

### Phase 4 — console behaviour (`src/console/public/console.js`, `src/console/server.ts`)

- `renderTiles`: `article.card[.refused]` (revoked → `.refused`), `h3` title, `.meta` with chips
  — `status index <n>`, `role credential` or `resource passport`, and the org on the officer
  tile; `.right` with the ACTIVE/REVOKED badge and `.actions`; `.desc` for the effect line.
  Revoke → `button.danger`; Restore → base button; Send offer → `.auth-primary`, `disabled` plus
  a `.note` "Link the wallet to push the offer" when `wallet.linked` is false.
- Offer result → `<div class="panel offer" id="offer-note">` containing a `.delivery.sent` or
  `.delivery.failed` line (same classes as the Trust Lens delivery line), a `.qr` rendered with
  `ui.renderQr`, the URI in `.uri` with a `Copy` button (`ui.copyText`), and the single-use note.
- `server.ts`: add `app.delete('/api/wallet/link', …)` mirroring `src/web/server.ts:133-136`.
- `linkWallet` shows `Linking…` and disables the button; `unlinkWallet` calls the new route;
  `renderWallet` delegates to `ui.renderWalletChip` (shows the `(from HOLDER_PUBLIC_DID)` hint).
- `load()` fetches `/api/wallet` and `/api/credentials` together inside `try/catch`; a failure
  renders `<p class="failure">…</p>` above the tiles instead of replacing them; a muted
  `updated <hh:mm:ss>` line under the tiles.
- Revoke failure: inline `.refusal` text inside the card, no `alert()`.
- Tabs: the same `showView` pattern as `app.js`.

### Phase 5 — Activity (after T1-C3)

`GET /api/audit` → `.timeline` entries `when · type`, `subject — outcome`, evidence rendered as
`.kv` (index, list, delivered, via). Tone: `revocation` with outcome `REVOKED` is `bad`,
`RESTORED` is `ok`, `issuance` neutral. Polled every 5 s while the tab is visible.

### Phase 6 — docs

`README.md` (console description; "shown for a phone that would rather scan it" is now true),
`docs/ARCHITECTURE.md` layout (`src/web/public/ui.js` is shared UI),
`.claude/skills/wallet-flow/SKILL.md` (the offer QR is on the console page).

## Definition of Done

- [ ] `src/console/public/index.html` contains no `<style>` element and no inline `style=`.
- [ ] `grep -n "^const el =\|^const escapeHtml =\|^function renderQr" src/web/public/app.js src/console/public/console.js`
      returns nothing; both files use `ui.*`.
- [ ] The console header has the `Issuer` chip and the Link / Unlink / Linking… states; the wallet
      chip updates within 5 s after linking or unlinking from the Trust Lens.
- [ ] Tiles use `.card`; Revoke is visibly a danger action; Send offer is disabled without a wallet.
- [ ] The offer result shows a scannable QR, a working Copy button and the delivery line.
- [ ] No `alert()` in `console.js`; network and revoke failures are shown inline.
- [ ] `app.css` has `h2`, `:focus-visible`, `.danger`, `.panel`, `.role-chip`, the 720 px
      breakpoint, centred `main`, and no `.auth-row` / `#auth-qr`.
- [ ] The Activity tab lists revocations and offers (phase 5; T1-C3 is already in this branch).
- [ ] Trust Lens: no visual regression beyond the intended shared fixes (heading size, centring,
      focus ring); all its flows still work (Discovery → Verify → Engage → panel; MCP tab; Audit).
- [ ] Global DoD (README).

## Steps to validate

1. **Helpers are shared and served**

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4100/shared/ui.js
   ```

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4100/shared/vendor/qrcode-generator.js
   ```

   Both print `200`. Browser console on `http://localhost:4100` and `http://localhost:4000`: no
   errors.

2. **Header parity** — on `:4100` the title reads _TrustCo Console_ with an `Issuer` chip; paste a
   wallet DID → the button shows `Linking…`, then the chip turns green; open `:4000` → the chip is
   green there too; press **Unlink** on `:4100` → within 5 s `:4000` shows _not linked_.

   ```bash
   curl -s -X DELETE http://localhost:4100/api/wallet/link
   ```

   Expect `{"linked":false}`.

3. **Tiles** — three `.card` articles; chips `status index 3` and `role credential` on the
   officer tile, `resource passport` on the other two; Revoke is red-outlined, Restore plain. With
   no wallet linked, _Send offer to wallet_ is disabled and the note explains why.

4. **Offer result** — link the wallet, press _Send offer to wallet_: a panel with the delivery
   line `Offer delivered …`, a QR, the URI and a **Copy** button that flips to _Copied_. With the
   wallet unlinked the panel still shows the QR and URI with the "no wallet linked" line. The QR
   decodes to the same `openid-credential-offer://…` as:

   ```bash
   curl -s -X POST http://localhost:4100/api/credentials/officer/offer | jq -r .offer
   ```

5. **Inline errors** — start the console against a wrong Heka port:

   ```bash
   IDENTITY_SERVICE_URL=http://localhost:3999 yarn console
   ```

   The page shows a `.failure` line above the tiles and no dialog. Restart normally; the line
   disappears on the next poll.

6. **Responsive and keyboard** — resize the window to 700 px wide: the header stacks, cards are
   one column, the DID input fills the row. Tab through the page: every button and input shows
   the accent focus ring.

7. **Activity (phase 5)** — Revoke and Restore the MCP passport; the Activity tab shows two
   entries (`REVOKED` red, `RESTORED` green) with the index and the list URL; send an offer → an
   `issuance` entry appears.

8. **Trust Lens unchanged** — run `demo-walkthrough` steps 1–5 in the UI; screenshots of
   Discovery and the MCP tab before and after the branch differ only in the `h2` size, centred
   content and focus rings.

## Docs to update

`README.md` (§ TrustCo Console), `docs/ARCHITECTURE.md` (layout table),
`.claude/skills/wallet-flow/SKILL.md` (the offer QR now lives on the console page).

## Risks and open questions

- Extracting `ui.js` touches `app.js`, which T3 rewrites heavily. Because T3 branches from this
  task, `ui.js` is already in place when T3 starts; T3 must call `ui.renderQr` rather than
  re-introduce a local copy.
- The QR encoder is vendored and untracked in git today; phase 1 assumes the housekeeping commit
  from the README has landed.
