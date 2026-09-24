/* TrustCo Console — three credentials, one switch each, and the issuer's hand-over of the officer credential. */

const el = (id) => document.getElementById(id)
const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )

let wallet = { linked: false }
let minting = false

function renderTiles(credentials) {
  el('tiles').innerHTML = credentials
    .map(
      (credential) => `
        <article class="tile ${credential.revoked ? 'revoked' : ''}">
          <div>
            <h3>${escapeHtml(credential.title)}</h3>
            <div class="meta"><span>${escapeHtml(credential.subtitle)}</span></div>
          </div>
          <div class="right">
            <span class="badge ${credential.revoked ? 'bad' : 'ok'}">${credential.revoked ? 'REVOKED' : 'ACTIVE'}</span>
            <div class="actions">
              ${credential.key === 'officer' ? `<button data-offer="officer" ${wallet.linked ? '' : 'title="Link the wallet first"'}>Send offer to wallet</button>` : ''}
              <button data-key="${escapeHtml(credential.key)}" data-revoke="${credential.revoked ? 'false' : 'true'}">
                ${credential.revoked ? 'Restore' : 'Revoke'}
              </button>
            </div>
          </div>
          <p class="effect">${escapeHtml(credential.effect)}</p>
          ${credential.key === 'officer' ? '<div class="offer-note" id="offer-note"></div>' : ''}
        </article>`
    )
    .join('')
}

function renderIssuer(data) {
  el('issuer').innerHTML = [
    ['Issuer', `${data.issuer.name} (${data.issuer.legalName})`],
    ['Issuer DID', data.issuer.did],
    ['Status list', data.statusList],
  ]
    .map(([label, value]) => `<div><span>${escapeHtml(label)}</span><code>${escapeHtml(value)}</code></div>`)
    .join('')
}

function renderWallet() {
  const chip = el('wallet-chip')
  chip.className = `badge ${wallet.linked ? 'ok' : ''}`
  chip.textContent = wallet.linked ? `wallet: linked · ${wallet.holderDid.slice(0, 22)}…` : 'wallet: not linked'
  chip.title = wallet.holderDid ?? ''
  el('wallet-did').hidden = wallet.linked
  el('wallet-link').hidden = wallet.linked
}

async function loadWallet() {
  const response = await fetch('/api/wallet')
  wallet = response.ok ? await response.json() : { linked: false }
  renderWallet()
}

async function linkWallet() {
  el('wallet-error').textContent = ''
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
}

async function load() {
  if (minting) return // do not swap the button out from under an in-flight request
  const response = await fetch('/api/credentials')
  const data = await response.json()
  if (!response.ok) {
    el('tiles').innerHTML = `<p class="note">${escapeHtml(data.error)}</p>`
    return
  }
  const note = el('offer-note')?.innerHTML
  renderTiles(data.credentials)
  if (note) el('offer-note').innerHTML = note
  renderIssuer(data)
}

async function sendOffer(button) {
  minting = true
  button.disabled = true
  button.textContent = 'Minting…'
  const note = el('offer-note')
  note.innerHTML = ''

  try {
    const response = await fetch('/api/credentials/officer/offer', { method: 'POST' })
    const data = await response.json()

    if (!response.ok && !data.offer) {
      note.innerHTML = `<span class="bad">${escapeHtml(data.error)}</span>`
      return
    }

    const status = data.delivered
      ? '<span class="ok">Offer delivered to the operator’s wallet over DIDComm — the person taps <strong>Accept</strong> there.</span>'
      : `<span class="bad">${escapeHtml(data.error ?? data.note ?? 'not delivered')}</span>`

    note.innerHTML = `${status}
      <div class="uri"><code>${escapeHtml(data.offer)}</code></div>
      <p class="note">The offer is single-use. Mint another for a second device or after the wallet is reset.</p>`
  } finally {
    minting = false
    button.disabled = false
    button.textContent = 'Send offer to wallet'
  }
}

el('tiles').addEventListener('click', async (event) => {
  const offer = event.target.closest('[data-offer]')
  if (offer) return sendOffer(offer)

  const button = event.target.closest('[data-key]')
  if (!button) return

  button.disabled = true
  const previous = button.textContent
  button.textContent = '…'

  try {
    const response = await fetch(`/api/credentials/${button.dataset.key}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revoked: button.dataset.revoke === 'true' }),
    })
    const data = await response.json()
    if (response.ok) renderTiles(data.credentials)
    else {
      button.textContent = previous
      alert(data.error)
    }
  } finally {
    button.disabled = false
  }
})

el('wallet-link').addEventListener('click', linkWallet)
el('wallet-did').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') linkWallet()
})

loadWallet()
load()
setInterval(load, 5000)
