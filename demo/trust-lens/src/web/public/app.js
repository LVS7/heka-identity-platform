/* Trust Lens UI. Deliberately dependency-free (one vendored QR encoder): the interesting part is the trust model. */

const state = { results: [], verdicts: new Map(), wallet: { linked: false } }

const { el, escapeHtml } = ui

const VERDICT_CLASS = { VERIFIED: 'ok' }
const badgeClass = (verdict) => VERDICT_CLASS[verdict] ?? (verdict ? 'bad' : '')
const isAgent = (result) => result.type.includes('a2a')

// ---------- operator's wallet ----------

async function loadWallet() {
  const response = await fetch('/api/wallet')
  state.wallet = response.ok ? await response.json() : { linked: false }
  renderWallet()
}

function renderWallet() {
  ui.renderWalletChip(
    { chipId: 'wallet-chip', inputId: 'wallet-did', linkId: 'wallet-link', unlinkId: 'wallet-unlink' },
    state.wallet
  )
  // The send buttons depend on the link; re-render whichever panel is open.
  renderSendButton('task')
  renderSendButton('mcp')
}

async function linkWallet() {
  const holderDid = el('wallet-did').value.trim()
  el('wallet-error').textContent = ''
  el('wallet-link').disabled = true
  el('wallet-link').textContent = 'Linking…'

  try {
    const response = await fetch('/api/wallet/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ holderDid }),
    })
    const data = await response.json()
    if (!response.ok) {
      el('wallet-error').textContent = data.error
      return
    }
    state.wallet = data
    renderWallet()
  } finally {
    el('wallet-link').disabled = false
    el('wallet-link').textContent = 'Link wallet'
  }
}

async function unlinkWallet() {
  const response = await fetch('/api/wallet/link', { method: 'DELETE' })
  state.wallet = response.ok ? await response.json() : { linked: false }
  renderWallet()
}

// ---------- discovery ----------

async function search(query) {
  const response = await fetch(`/api/discovery?q=${encodeURIComponent(query)}`)
  const data = await response.json()

  state.results = data.results ?? []
  state.verdicts.clear()

  el('score-note').textContent = state.results.length ? `Score: ${data.scoreMeaning}` : ''
  el('verify-all').disabled = state.results.length === 0
  render()
}

function render() {
  const container = el('results')
  el('empty').hidden = state.results.length > 0

  container.innerHTML = state.results
    .map((result) => {
      const verdict = state.verdicts.get(result.identifier)
      const badge = verdict
        ? `<span class="badge ${badgeClass(verdict.verdict)}">${escapeHtml(verdict.verdict)}</span>`
        : `<span class="badge">Not verified</span>`

      const engageable = verdict?.engageable
      const actions = verdict
        ? `<div class="actions">
             <button data-details="${escapeHtml(result.identifier)}">Evidence</button>
             <button data-engage="${escapeHtml(result.identifier)}" ${engageable ? '' : 'disabled'}>Engage</button>
           </div>
           ${engageable ? '' : '<span class="refusal">refused: not verified</span>'}`
        : ''

      const kind = isAgent(result) ? 'A2A agent' : 'MCP server'

      return `
        <article class="card ${verdict && !engageable ? 'refused' : ''}">
          <div>
            <h3>${escapeHtml(result.displayName)}</h3>
            <div class="meta">
              <span class="chip">${escapeHtml(kind)}</span>
              <span>${escapeHtml(result.publisher)}</span>
              ${result.hasAttestation ? '' : '<span class="chip">no attestation</span>'}
            </div>
          </div>
          <div class="right">
            ${badge}
            <span class="score">relevance ${result.score}</span>
            ${actions}
          </div>
          <p class="desc">${escapeHtml(result.description ?? '')}</p>
        </article>`
    })
    .join('')
}

async function verifyAll() {
  const button = el('verify-all')
  button.disabled = true
  button.textContent = 'Verifying…'

  try {
    const response = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifiers: state.results.map((r) => r.identifier) }),
    })
    const data = await response.json()
    for (const result of data.results ?? []) state.verdicts.set(result.identifier, result)
    render()
  } finally {
    button.textContent = 'Verify all'
    button.disabled = false
  }
}

// ---------- evidence drawer ----------

const CHECKS = [
  ['urnPublisherFqdn', 'URN publisher matches the serving domain'],
  ['didResolved', 'Identity resolves on Hedera'],
  ['digestValid', 'Attestation matches the digest in the catalog'],
  ['signatureValid', 'Credential signature is valid'],
  ['validityWindowOk', 'Credential is within its validity window'],
  ['issuerTrusted', 'Issued by a trusted anchor'],
  ['subjectBinding', 'Credential subject is this resource'],
  ['operatorDomain', 'Attested operator domain matches the publisher'],
  ['cardDigestValid', 'Resource card matches its passport'],
  ['statusLive', 'Not revoked'],
]

function checkState(key, evidence, verdict) {
  switch (key) {
    case 'urnPublisherFqdn':
      return evidence.urnPublisherFqdn === evidence.servingDomain
    case 'subjectBinding':
      return verdict === 'SUBJECT_MISMATCH' ? false : evidence.subjectDid ? true : undefined
    case 'operatorDomain':
      return verdict === 'OPERATOR_DOMAIN_MISMATCH' ? false : evidence.operatorDomain ? true : undefined
    case 'statusLive':
      if (evidence.statusListChecked === false) return false
      return evidence.statusRevoked === undefined ? undefined : !evidence.statusRevoked
    default:
      return evidence[key]
  }
}

function openDrawer(identifier) {
  const result = state.results.find((r) => r.identifier === identifier)
  const verdict = state.verdicts.get(identifier)
  if (!result || !verdict) return

  const evidence = verdict.evidence ?? {}

  el('drawer-title').textContent = result.displayName
  el('drawer-verdict').innerHTML =
    `<span class="badge ${badgeClass(verdict.verdict)}">${escapeHtml(verdict.verdict)}</span>`

  const checks = CHECKS.map(([key, label]) => {
    const value = checkState(key, evidence, verdict.verdict)
    const mark = value === true ? ['ok', '✓'] : value === false ? ['bad', '✕'] : ['skip', '–']
    return `<li><span class="mark ${mark[0]}">${mark[1]}</span><span>${escapeHtml(label)}</span></li>`
  }).join('')

  const rows = [
    ['Operator', evidence.operatorLegalName],
    ['Operator domain', evidence.operatorDomain],
    ['Publisher', evidence.servingDomain],
    ['Resource identity', evidence.identity],
    ['Credential subject', evidence.subjectDid],
    ['Issuer', evidence.issuerDid],
    ['Attestation', evidence.attestationUri],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `<div><span>${escapeHtml(label)}</span><code>${escapeHtml(value)}</code></div>`)
    .join('')

  el('drawer-body').innerHTML = `
    <ul class="checks">${checks}</ul>
    ${evidence.failureDetail ? `<div class="failure">${escapeHtml(evidence.failureDetail)}</div>` : ''}
    <div class="kv">${rows}</div>`

  setDrawerOpen(true)
}

function setDrawerOpen(open) {
  el('drawer').hidden = !open
  el('backdrop').hidden = !open
}

// ---------- authorization panel (shared by the task view and the MCP view) ----------

// `panel` is 'task' or 'mcp'; element ids are `${panel}-send`, `${panel}-qr`, and so on.
const auth = {
  task: { request: null, delivery: null },
  mcp: { request: null, delivery: null },
}

function renderSendButton(panel) {
  const button = el(`${panel}-send`)
  if (!button) return
  const { linked } = state.wallet
  const { delivery } = auth[panel]
  button.disabled = !linked
  button.textContent = delivery ? 'Resend to wallet' : 'Send to wallet'
  button.title = linked ? '' : 'Link the wallet first — paste its Public DID in the header'
}

function renderDelivery(panel) {
  const { delivery } = auth[panel]
  const target = el(`${panel}-delivery`)
  if (!delivery) {
    target.className = 'delivery'
    target.textContent = state.wallet.linked
      ? ''
      : 'No wallet linked — paste its Public DID in the header, or use the other ways below.'
    return
  }
  const at = ui.formatWhen(delivery.at)
  target.className = `delivery ${delivery.state}`
  target.textContent =
    delivery.state === 'sent'
      ? `Sent ${at} · waiting for Share in Heka Wallet…`
      : `Delivery failed ${at}: ${delivery.error}`
}

function showAuthPanel(panel, request, delivery) {
  const changed = auth[panel].request !== request
  auth[panel].request = request
  auth[panel].delivery = delivery ?? (changed ? null : auth[panel].delivery)

  if (changed) {
    ui.renderQr(el(`${panel}-qr`), request)
    el(`${panel}-uri`).textContent = request
    el(`${panel}-simulate-note`).textContent = ''
  }
  renderSendButton(panel)
  renderDelivery(panel)
  el(`${panel}-auth`).hidden = false
}

function hideAuthPanel(panel) {
  auth[panel] = { request: null, delivery: null }
  el(`${panel}-auth`).hidden = true
}

async function sendToWallet(panel) {
  const button = el(`${panel}-send`)
  button.disabled = true
  button.textContent = 'Sending…'

  try {
    const url = panel === 'task' ? `/api/task/${state.taskId}/send-to-wallet` : '/api/mcp/send-to-wallet'
    const response = await fetch(url, { method: 'POST' })
    const data = await response.json()
    auth[panel].delivery = data.delivery ?? { state: 'failed', at: new Date().toISOString(), error: data.error }
    renderDelivery(panel)
  } finally {
    renderSendButton(panel)
  }
}

// ---------- agent task ----------

let taskPoll = null

async function engage(identifier) {
  const result = state.results.find((r) => r.identifier === identifier)

  // The server re-verifies before engaging; the verdict this page holds is display only.
  const response = await fetch('/api/engage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  })
  const data = await response.json()

  if (!response.ok) {
    alert(data.verdict ? `refused: ${data.verdict} at engagement time` : data.error)
    return
  }

  const verifiedAt = ui.formatWhen(data.verifiedAt)

  // An MCP server is not engaged with a task: its tools are on the MCP tab. Going there is the
  // engagement, and the fresh verdict travels along so the tab can say what was verified.
  if (data.kind === 'mcp') {
    el('mcp-engaged').hidden = false
    el('mcp-engaged').textContent =
      `${result?.displayName ?? identifier} — re-verified ${verifiedAt} · VERIFIED (${result?.publisher ?? ''}). Verified is not the same as unlocked: the sensitive tool below still demands a scope.`
    showView('mcp')
    loadTools()
    return
  }

  el('task-title').textContent = result?.displayName ?? identifier
  el('task-context').textContent =
    `Re-verified ${verifiedAt} · VERIFIED · ${result?.publisher ?? ''} — asking it to reconcile May invoices and prepare the payment export`
  el('task-events').innerHTML = ''
  el('task-result').hidden = true
  hideAuthPanel('task')

  showView('task')
  watchTask(data.taskId)
}

function watchTask(taskId) {
  clearInterval(taskPoll)
  state.taskId = taskId

  const tick = async () => {
    const response = await fetch(`/api/task/${taskId}`)
    if (!response.ok) return
    const task = await response.json()

    el('task-events').innerHTML = task.events
      .map(
        (event) => `<li class="${event.state === 'failed' ? 'bad' : event.state === 'completed' ? 'ok' : ''}">
            <div class="when">${escapeHtml(event.at)} · ${escapeHtml(event.state)}</div>
            ${escapeHtml(event.text ?? '')}
          </li>`
      )
      .join('')

    if (task.authorizationRequest) showAuthPanel('task', task.authorizationRequest, task.delivery)
    else hideAuthPanel('task')

    if (task.result || task.error) {
      el('task-result').hidden = false
      el('task-result').textContent = task.result ?? task.error
      clearInterval(taskPoll)
    }
  }

  tick()
  taskPoll = setInterval(tick, 1500)
}

async function simulatePresentation() {
  const button = el('task-simulate')
  button.disabled = true
  el('task-simulate-note').textContent = 'Presenting…'

  try {
    const response = await fetch(`/api/task/${state.taskId}/simulate-presentation`, { method: 'POST' })
    const data = await response.json()
    el('task-simulate-note').textContent = response.ok ? 'Presented by the in-process holder.' : data.error
  } finally {
    button.disabled = false
  }
}

function showView(name) {
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === name))
  document
    .querySelectorAll('.tab[data-view]')
    .forEach((tab) => tab.classList.toggle('active', tab.dataset.view === name))
}

// ---------- MCP tools ----------

let authPoll = null

async function loadTools() {
  const response = await fetch('/api/mcp/tools')
  const data = await response.json()

  if (!response.ok) {
    el('tools').innerHTML = `<p class="note">${escapeHtml(data.error)}</p>`
    return
  }

  renderTokenStatus(data.token)

  el('tools').innerHTML = (data.tools ?? [])
    .map(
      (tool) => `
        <article class="card">
          <div>
            <h3>${escapeHtml(tool.name)}</h3>
            <div class="meta">
              ${tool.requiredScope ? `<span class="chip">scope ${escapeHtml(tool.requiredScope)}</span>` : '<span class="chip">no elevated scope</span>'}
            </div>
          </div>
          <div class="right">
            <button data-tool="${escapeHtml(tool.name)}">Invoke</button>
          </div>
          <p class="desc">${escapeHtml(tool.description)}</p>
        </article>`
    )
    .join('')
}

function renderTokenStatus(token) {
  const badge = el('token-status')
  if (token?.present) {
    badge.className = 'badge ok'
    badge.textContent = `token · ${token.expiresInSeconds}s left`
  } else {
    badge.className = 'badge'
    badge.textContent = 'no token'
  }
  el('token-drop').hidden = !token?.present
}

async function invokeTool(name) {
  el('mcp-result').hidden = true
  hideAuthPanel('mcp')
  clearInterval(authPoll)

  const response = await fetch('/api/mcp/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: name }),
  })
  const data = await response.json()

  if (data.ok) {
    el('mcp-result').hidden = false
    const by = data.result?.authorizedBy
    el('mcp-result').textContent =
      (by?.role ? `Authorized by ${by.role} · ${by.org}\n\n` : '') +
      JSON.stringify(data.result?.content ?? data.result, null, 2)
    renderTokenStatus(data.token)
    return
  }

  if (data.authorization) {
    el('mcp-auth-title').textContent =
      `${data.status === 403 ? 'Insufficient scope' : 'Authorization required'} — ${data.requiredScope}`
    el('mcp-auth-message').textContent = data.authorization.message ?? ''
    showAuthPanel('mcp', data.authorization.request, null)
    pollAuthorization(name)
    return
  }

  el('mcp-result').hidden = false
  el('mcp-result').textContent = data.error ?? JSON.stringify(data, null, 2)
}

function pollAuthorization(toolToRetry) {
  clearInterval(authPoll)
  authPoll = setInterval(async () => {
    const response = await fetch('/api/mcp/authorization')
    const data = await response.json()

    if (response.status === 403) {
      clearInterval(authPoll)
      el('mcp-simulate-note').textContent = data.error
      auth.mcp.delivery = { state: 'failed', at: new Date().toISOString(), error: data.error }
      renderDelivery('mcp')
      return
    }

    if (data.granted) {
      clearInterval(authPoll)
      hideAuthPanel('mcp')
      renderTokenStatus(data.token)
      invokeTool(toolToRetry) // step-up complete: retry the original call
      return
    }

    // Keep the delivery line in step with what the server recorded (a resend from another tab, say).
    if (data.delivery && data.delivery.at !== auth.mcp.delivery?.at) {
      auth.mcp.delivery = data.delivery
      renderDelivery('mcp')
      renderSendButton('mcp')
    }
  }, 2000)
}

async function simulateMcpPresentation() {
  const button = el('mcp-simulate')
  button.disabled = true
  el('mcp-simulate-note').textContent = 'Presenting…'

  try {
    const response = await fetch('/api/mcp/simulate-presentation', { method: 'POST' })
    const data = await response.json()
    el('mcp-simulate-note').textContent = response.ok ? 'Presented by the in-process holder.' : data.error
  } finally {
    button.disabled = false
  }
}

async function dropToken() {
  const response = await fetch('/api/mcp/token', { method: 'DELETE' })
  const data = await response.json()
  renderTokenStatus(data.token)
  el('mcp-result').hidden = false
  el('mcp-result').textContent =
    'Cached token dropped. The next sensitive call has to authorize again — against the credential as it stands now.'
}

// ---------- audit ----------

async function loadAudit() {
  const response = await fetch('/api/audit')
  const data = await response.json()

  // A refusal is as much a trust decision as an approval; colour by what happened, not by type.
  const REFUSALS = ['denial', 'engagement_refused', 'revocation']
  const tone = (event) => {
    if (REFUSALS.includes(event.type)) return 'bad'
    if (event.outcome === 'VERIFIED') return 'ok'
    if (event.type === 'verification') return 'bad'
    return ''
  }

  el('audit-list').innerHTML =
    (data.events ?? [])
      .map((event) => {
        const detail = event.evidence?.failureDetail ?? event.evidence?.note
        return `<li class="${tone(event)}">
          <div class="when">${escapeHtml(event.timestamp)} · ${escapeHtml(event.type)}</div>
          <strong>${escapeHtml(event.subject)}</strong> — ${escapeHtml(event.outcome)}
          ${detail ? `<div class="note">${escapeHtml(detail)}</div>` : ''}
        </li>`
      })
      .join('') || '<li class="note">No trust decisions recorded yet.</li>'
}

// ---------- wiring ----------

el('search-form').addEventListener('submit', (event) => {
  event.preventDefault()
  search(el('query').value)
})

el('verify-all').addEventListener('click', verifyAll)
el('drawer-close').addEventListener('click', () => setDrawerOpen(false))
el('backdrop').addEventListener('click', () => setDrawerOpen(false))
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setDrawerOpen(false)
})

el('results').addEventListener('click', (event) => {
  const details = event.target.closest('[data-details]')
  if (details) return openDrawer(details.dataset.details)

  const engageTarget = event.target.closest('[data-engage]')
  if (engageTarget && !engageTarget.disabled) engage(engageTarget.dataset.engage)
})

el('wallet-link').addEventListener('click', linkWallet)
el('wallet-unlink').addEventListener('click', unlinkWallet)
el('wallet-did').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') linkWallet()
})

document.addEventListener('click', (event) => {
  const send = event.target.closest('[data-send]')
  if (send && !send.disabled) sendToWallet(send.dataset.send)

  const copy = event.target.closest('[data-copy]')
  if (copy) ui.copyText(el(copy.dataset.copy).textContent, copy)
})

el('task-simulate').addEventListener('click', simulatePresentation)
el('task-back').addEventListener('click', () => {
  clearInterval(taskPoll)
  showView('discovery')
})

el('mcp-simulate').addEventListener('click', simulateMcpPresentation)
el('token-drop').addEventListener('click', dropToken)
el('tools').addEventListener('click', (event) => {
  const button = event.target.closest('[data-tool]')
  if (button) invokeTool(button.dataset.tool)
})

document.querySelectorAll('.tab[data-view]').forEach((tab) => {
  tab.addEventListener('click', () => {
    clearInterval(taskPoll)
    clearInterval(authPoll)
    showView(tab.dataset.view)
    if (tab.dataset.view === 'audit') loadAudit()
    if (tab.dataset.view === 'mcp') loadTools()
  })
})

loadWallet()
search(el('query').value)
