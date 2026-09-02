/* Trust Lens UI. Deliberately dependency-free: the interesting part is the trust model. */

const state = { results: [], verdicts: new Map() }

const el = (id) => document.getElementById(id)
const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const VERDICT_CLASS = { VERIFIED: 'ok' }
const badgeClass = (verdict) => VERDICT_CLASS[verdict] ?? (verdict ? 'bad' : '')

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

      const kind = result.type.includes('a2a') ? 'A2A agent' : 'MCP server'

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
  el('drawer-verdict').innerHTML = `<span class="badge ${badgeClass(verdict.verdict)}">${escapeHtml(verdict.verdict)}</span>`

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

// ---------- agent task ----------

let taskPoll = null

async function engage(identifier) {
  const verdict = state.verdicts.get(identifier)
  const response = await fetch('/api/engage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, verdict: verdict?.verdict }),
  })
  const data = await response.json()

  if (!response.ok) {
    alert(data.error)
    return
  }

  const result = state.results.find((r) => r.identifier === identifier)
  el('task-title').textContent = result?.displayName ?? identifier
  el('task-context').textContent = `VERIFIED · ${result?.publisher ?? ''} — asking it to reconcile May invoices and prepare the payment export`
  el('task-events').innerHTML = ''
  el('task-result').hidden = true
  el('auth-panel').hidden = true
  el('simulate-note').textContent = ''

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

    const waiting = Boolean(task.authorizationRequest)
    el('auth-panel').hidden = !waiting
    if (waiting) {
      el('auth-qr').src = `https://api.qrserver.com/v1/create-qr-code/?size=360x360&data=${encodeURIComponent(task.authorizationRequest)}`
    }

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
  const button = el('simulate')
  button.disabled = true
  el('simulate-note').textContent = 'Presenting…'

  try {
    const response = await fetch(`/api/task/${state.taskId}/simulate-presentation`, { method: 'POST' })
    const data = await response.json()
    el('simulate-note').textContent = response.ok ? 'Presented by the in-process holder.' : data.error
  } finally {
    button.disabled = false
  }
}

function showView(name) {
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === name))
  document.querySelectorAll('.tab[data-view]').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === name))
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
}

async function invokeTool(name) {
  el('mcp-result').hidden = true
  el('mcp-auth').hidden = true
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
      (by?.role ? `Authorized by ${by.role} · ${by.org}\n\n` : '') + JSON.stringify(data.result?.content ?? data.result, null, 2)
    renderTokenStatus(data.token)
    return
  }

  if (data.authorization) {
    el('mcp-auth').hidden = false
    el('mcp-auth-title').textContent = `${data.status === 403 ? 'Insufficient scope' : 'Authorization required'} — ${data.requiredScope}`
    el('mcp-auth-message').textContent = data.authorization.message ?? ''
    el('mcp-auth-note').textContent = ''
    el('mcp-qr').src = `https://api.qrserver.com/v1/create-qr-code/?size=360x360&data=${encodeURIComponent(data.authorization.request)}`
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
      el('mcp-auth-note').textContent = data.error
      return
    }

    if (data.granted) {
      clearInterval(authPoll)
      el('mcp-auth').hidden = true
      renderTokenStatus(data.token)
      invokeTool(toolToRetry) // step-up complete: retry the original call
    }
  }, 2000)
}

async function simulateMcpPresentation() {
  const button = el('mcp-simulate')
  button.disabled = true
  el('mcp-auth-note').textContent = 'Presenting…'

  try {
    const response = await fetch('/api/mcp/simulate-presentation', { method: 'POST' })
    const data = await response.json()
    el('mcp-auth-note').textContent = response.ok ? 'Presented by the in-process holder.' : data.error
  } finally {
    button.disabled = false
  }
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

el('simulate').addEventListener('click', simulatePresentation)
el('task-back').addEventListener('click', () => {
  clearInterval(taskPoll)
  showView('discovery')
})

el('mcp-simulate').addEventListener('click', simulateMcpPresentation)
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

search(el('query').value)
