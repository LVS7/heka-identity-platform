/* TrustCo Console — three credentials, one switch each. */

const el = (id) => document.getElementById(id)
const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

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
            <button data-key="${escapeHtml(credential.key)}" data-revoke="${credential.revoked ? 'false' : 'true'}">
              ${credential.revoked ? 'Restore' : 'Revoke'}
            </button>
          </div>
          <p class="effect">${escapeHtml(credential.effect)}</p>
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

async function load() {
  const response = await fetch('/api/credentials')
  const data = await response.json()
  if (!response.ok) {
    el('tiles').innerHTML = `<p class="note">${escapeHtml(data.error)}</p>`
    return
  }
  renderTiles(data.credentials)
  renderIssuer(data)
}

el('tiles').addEventListener('click', async (event) => {
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

load()
setInterval(load, 5000)
