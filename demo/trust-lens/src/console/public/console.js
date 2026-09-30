/* TrustCo Console — the issuer's side: three credentials with a revoke switch each, the officer offer, and a journal. */

const { el, escapeHtml } = ui

let wallet = { linked: false }
/**
 * Requests in flight (offer, revoke/restore, link, unlink). While any runs the poll stays away:
 * rebuilding the tiles would swap the pressed button out from under its request.
 */
let busy = 0
/** The last minted offer, kept across re-renders so the QR does not vanish under the operator. */
let lastOffer = null
/** Per-tile error lines, by credential key; the tiles are rebuilt as HTML and would drop them. */
const errors = new Map()
/**
 * What the tiles and the issuer panel were last rendered from. The poll only rebuilds when the
 * data changed, so focus, a text selection and the QR survive a quiet 5 s tick.
 */
let tilesSignature = ''
let issuerSignature = ''
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
          <p class="refusal" id="error-${escapeHtml(credential.key)}">${escapeHtml(errors.get(credential.key) ?? '')}</p>
          ${credential.key === 'officer' ? '<div class="offer-slot" id="offer-note"></div>' : ''}
        </article>`
    )
    .join('')
  renderOffer()
}

/** Render the tiles only if they would change; the button label depends on the wallet too. */
function showCredentials(credentials) {
  const signature = `${JSON.stringify(credentials)}|${String(wallet.linked)}`
  if (signature === tilesSignature) return
  tilesSignature = signature
  renderTiles(credentials)
}

/** Set (or, with an empty message, clear) a tile's error line, now and across later re-renders. */
function setError(key, message) {
  if (message) errors.set(key, message)
  else errors.delete(key)
  const line = el(`error-${key}`)
  if (line) line.textContent = message
}

function renderOffer() {
  const box = el('offer-note')
  if (!box) return
  if (!lastOffer) {
    box.innerHTML = ''
    return
  }

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
        <div class="qr" id="offer-qr" role="img" aria-label="Credential offer QR code"></div>
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
  const signature = JSON.stringify([data.issuer, data.statusList])
  if (signature === issuerSignature) return
  issuerSignature = signature
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
  busy++
  el('wallet-error').textContent = ''
  el('wallet-link').disabled = true
  el('wallet-link').textContent = 'Linking…'
  el('wallet-did').disabled = true

  let linked = false
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
    linked = true
  } catch (error) {
    el('wallet-error').textContent = `Could not link the wallet: ${error.message}`
  } finally {
    busy--
    el('wallet-link').disabled = false
    el('wallet-link').textContent = 'Link wallet'
    el('wallet-did').disabled = false
  }
  // After the finally, so the poll is no longer held off: the offer button's label follows the link.
  if (linked) load()
}

async function unlinkWallet() {
  busy++
  el('wallet-error').textContent = ''

  let unlinked = false
  try {
    const response = await fetch('/api/wallet/link', { method: 'DELETE' })
    const data = await response.json()
    if (!response.ok) {
      el('wallet-error').textContent = data.error
      return
    }
    wallet = data
    renderWallet()
    unlinked = true
  } catch (error) {
    el('wallet-error').textContent = `Could not unlink the wallet: ${error.message}`
  } finally {
    busy--
  }
  if (unlinked) load()
}

// ---------- loading ----------

/** Wallet and credentials together: a link made in the Trust Lens shows here within one poll. */
async function load() {
  if (busy) return

  try {
    const [walletResponse, response] = await Promise.all([fetch('/api/wallet'), fetch('/api/credentials')])
    // A request may have started while these were in flight; its result is newer than ours.
    if (busy) return
    wallet = walletResponse.ok ? await walletResponse.json() : { linked: false }
    renderWallet()

    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)

    showCredentials(data.credentials)
    renderIssuer(data)
    el('load-error').hidden = true
    el('updated').textContent = `updated ${ui.formatWhen(new Date().toISOString())}`
  } catch (error) {
    el('load-error').hidden = false
    el('load-error').textContent = `Could not read the issuer state: ${error.message}`
  }
}

async function sendOffer(button) {
  busy++
  button.disabled = true
  const label = button.textContent
  button.textContent = 'Minting…'

  try {
    const response = await fetch('/api/credentials/officer/offer', { method: 'POST' })
    const data = await response.json()
    // A 502 that still carries an offer is a failed delivery, not a failed mint: show the offer.
    if (!response.ok && !data.offer) throw new Error(data.error ?? `HTTP ${response.status}`)
    setError('officer', '')
    lastOffer = { offer: data.offer, delivered: Boolean(data.delivered), error: data.error, note: data.note }
  } catch (error) {
    lastOffer = null
    setError('officer', `Could not mint the offer: ${error.message}`)
  } finally {
    busy--
    button.disabled = false
    button.textContent = label
  }
  renderOffer()
}

async function toggleRevocation(button) {
  const key = button.dataset.key
  const revoke = button.dataset.revoke === 'true'
  busy++
  button.disabled = true
  const label = button.textContent
  button.textContent = revoke ? 'Revoking…' : 'Restoring…'

  try {
    const response = await fetch(`/api/credentials/${key}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revoked: revoke }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
    setError(key, '')
    showCredentials(data.credentials)
  } catch (error) {
    setError(key, `Could not ${revoke ? 'revoke' : 'restore'}: ${error.message}`)
  } finally {
    busy--
    // On success the tiles were rebuilt and this button is detached; restoring it is harmless.
    button.disabled = false
    button.textContent = label
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
  let data
  try {
    const response = await fetch('/api/audit')
    data = await response.json()
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
  } catch (error) {
    // This runs every 5 s; one visible line beats an unhandled rejection per tick.
    el('activity-list').innerHTML = `<li class="note">Could not read the journal: ${escapeHtml(error.message)}</li>`
    return
  }

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
