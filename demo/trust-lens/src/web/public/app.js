/* Trust Lens UI. Deliberately dependency-free (one vendored QR encoder): the interesting part is the trust model. */

const state = {
  results: [],
  verdicts: new Map(),
  wallet: { linked: false },
  config: { trustedIssuers: [], trustedIssuerName: '' },
  taskId: null,
}

const { el, escapeHtml } = ui

const VERDICT_CLASS = { VERIFIED: 'ok' }
const badgeClass = (verdict) => VERDICT_CLASS[verdict] ?? (verdict ? 'bad' : '')
const isAgent = (result) => result.type.includes('a2a')
const FINAL_STATES = ['authorized', 'denied', 'expired']
const shorten = (value, head = 24, tail = 6) =>
  value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value
const mmss = (seconds) =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`

async function loadConfig() {
  const response = await fetch('/api/config')
  if (response.ok) state.config = await response.json()
}

// ---------- polling that survives navigation ----------

// A tab switch used to clear every interval, which killed a pending task the moment you looked
// away. A poller now runs until its own work is final, whatever view is visible.
const pollers = new Map()

function startPoller(key, tick, ms) {
  stopPoller(key)
  pollers.set(key, setInterval(tick, ms))
  tick()
}

function stopPoller(key) {
  clearInterval(pollers.get(key))
  pollers.delete(key)
}

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

// ---------- the presentation card and the Raw VP drawer ----------

// Presentations shown anywhere on the page, by session id, so a Raw VP button can find its token.
const presentations = new Map()

const SOURCE_LABEL = {
  wallet: ['Heka Wallet (DIDComm)', 'ok'],
  qr: ['QR scan', 'ok'],
  simulated: ['Simulated holder (demo)', 'warn'],
  unknown: ['unknown', ''],
}

function issuerNote(issuer) {
  const trusted = (state.config.trustedIssuers ?? []).includes(issuer)
  return trusted ? `(${state.config.trustedIssuerName || 'trusted issuer'}, trusted)` : '(not a trusted issuer)'
}

function presentationCard(presentation, compact = false) {
  if (!presentation) return ''
  if (presentation.sessionId) presentations.set(presentation.sessionId, presentation)

  const denied = presentation.outcome === 'denied'
  const status = presentation.status
  const [sourceLabel, sourceTone] = SOURCE_LABEL[presentation.source] ?? SOURCE_LABEL.unknown
  const claims = Object.entries(presentation.claims ?? {})
    .map(([name, value]) => `<span class="chip">${escapeHtml(name)} · ${escapeHtml(String(value))}</span>`)
    .join(' ')
  const statusText = status
    ? `${status.revoked ? 'revoked' : 'live'} · index ${status.statusListIndex} · checked ${ui.formatWhen(status.checkedAt)}`
    : 'not checked'
  const code = (value) => `<code title="${escapeHtml(value)}">${escapeHtml(shorten(value))}</code>`

  const rows = [
    !denied && claims && ['Claims', claims],
    presentation.credentialType && ['Credential', `<code>${escapeHtml(presentation.credentialType)}</code>`],
    presentation.issuer && [
      'Issuer',
      `${code(presentation.issuer)} <span class="note">${escapeHtml(issuerNote(presentation.issuer))}</span>`,
    ],
    presentation.holder && ['Holder', code(presentation.holder)],
    [
      'Status',
      `<span class="${status?.revoked ? 'text-bad' : status ? 'text-ok' : ''}">${escapeHtml(statusText)}</span>`,
    ],
    presentation.sessionId && ['Session', `<code>${escapeHtml(presentation.sessionId.slice(0, 8))}</code>`],
    presentation.verifiedAt && ['Verified', escapeHtml(ui.formatWhen(presentation.verifiedAt))],
    ['Presented via', `<span class="badge ${sourceTone}">${escapeHtml(sourceLabel)}</span>`],
  ]
    .filter(Boolean)
    .map(([label, html]) => `<div><span>${escapeHtml(label)}</span><span>${html}</span></div>`)
    .join('')

  return `
    <article class="card presentation ${denied ? 'refused' : ''} ${compact ? 'compact' : ''}">
      <div>
        <h3>${denied ? 'Presentation refused' : 'Verified presentation'}</h3>
        ${denied ? `<p class="refusal">${escapeHtml(presentation.reason ?? '')}</p>` : ''}
      </div>
      <div class="right">
        <span class="badge ${denied ? 'bad' : 'ok'}">${denied ? 'DENIED' : 'AUTHORIZED'}</span>
        ${presentation.vpToken ? `<button data-raw-vp="${escapeHtml(presentation.sessionId ?? '')}">Raw VP</button>` : ''}
      </div>
      <div class="kv compact">${rows}</div>
    </article>`
}

/** base64url → JSON, in the browser; the disclosures are ASCII but the values need not be. */
function decodeSegment(segment) {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

function decodeJwtPayload(compact) {
  try {
    return decodeSegment(compact.split('.')[1])
  } catch {
    return { error: 'could not decode' }
  }
}

function openRawVp(presentation) {
  if (!presentation?.vpToken) return
  const segments = presentation.vpToken.split('~')
  const issuerJwt = segments[0]
  // Compact form: issuer-jwt ~ disclosure ~ … ~ [kb-jwt]; a trailing "~" means no key binding.
  const keyBinding = segments[segments.length - 1] || undefined
  const encoded = segments.slice(1, keyBinding ? -1 : undefined).filter(Boolean)
  const disclosures = encoded.map((segment) => {
    try {
      const [salt, name, value] = decodeSegment(segment)
      return { salt, name, value }
    } catch {
      return { salt: '?', name: '(undecodable)', value: segment }
    }
  })

  el('drawer-title').textContent = 'Raw verifiable presentation'
  el('drawer-verdict').innerHTML = `<span class="badge">compact SD-JWT · ${disclosures.length} disclosure${
    disclosures.length === 1 ? '' : 's'
  }${keyBinding ? ' · key binding' : ''}</span>`

  const rows = disclosures
    .map(
      (d) =>
        `<div><span>${escapeHtml(d.name ?? '(array element)')}</span><code>${escapeHtml(
          JSON.stringify(d.value)
        )} <span class="note">salt ${escapeHtml(d.salt)}</span></code></div>`
    )
    .join('')

  el('drawer-body').innerHTML = `
    <h3 class="raw-heading">Disclosures</h3>
    <div class="kv">${rows || '<div><span>none</span><span></span></div>'}</div>
    <h3 class="raw-heading">Issuer JWT payload</h3>
    <pre class="raw">${escapeHtml(JSON.stringify(decodeJwtPayload(issuerJwt), null, 2))}</pre>
    ${
      keyBinding
        ? `<h3 class="raw-heading">Key binding JWT payload</h3>
    <pre class="raw">${escapeHtml(JSON.stringify(decodeJwtPayload(keyBinding), null, 2))}</pre>`
        : ''
    }
    <h3 class="raw-heading">Compact token</h3>
    <pre class="raw">${escapeHtml(presentation.vpToken)}</pre>`

  setDrawerOpen(true)
}

// ---------- authorization panel (shared by the task view and the MCP view) ----------

// `panel` is 'task' or 'mcp'; element ids are `${panel}-send`, `${panel}-qr`, and so on.
const auth = {
  task: { request: null, delivery: null, authorization: null },
  mcp: { request: null, delivery: null, authorization: null },
}

const STEPS = ['Requested', 'Wallet fetched', 'Verified', 'Status checked', 'Authorized']

/** How many steps are done. A denial after a status check has walked the whole strip. */
function stepProgress(authorization, presentation) {
  switch (authorization.state) {
    case 'wallet-fetched':
      return 2
    case 'verified':
      return 3
    case 'authorized':
      return 5
    case 'denied':
      return presentation?.status ? 4 : presentation?.vpToken ? 3 : 1
    default:
      return 1
  }
}

function renderSteps(panel, authorization, presentation) {
  const failed = authorization.state === 'denied' || authorization.state === 'expired'
  const progress = stepProgress(authorization, presentation)
  el(`${panel}-steps`).innerHTML = STEPS.map((label, index) => {
    if (index === STEPS.length - 1 && failed) {
      return `<li class="bad">${authorization.state === 'expired' ? 'Expired' : 'Denied'}</li>`
    }
    const cls = index < progress ? 'done' : index === progress && !failed ? 'current' : ''
    return `<li class="${cls}">${escapeHtml(label)}</li>`
  }).join('')
}

function renderCountdown(panel, authorization) {
  const target = el(`${panel}-countdown`)
  if (!authorization?.expiresAt || FINAL_STATES.includes(authorization.state)) {
    target.textContent = ''
    target.className = 'countdown'
    return
  }
  const left = Math.max(0, Math.round((Date.parse(authorization.expiresAt) - Date.now()) / 1000))
  target.className = `countdown ${left <= 30 ? 'bad' : ''}`
  // The agent's own timeout, not the verifier session's lifetime — that one is shorter and not exposed.
  target.textContent =
    left > 0 ? `Agent timeout in ${mmss(left)}` : 'Agent timeout expired — waiting for the agent to give up'
}

function renderAsked(panel, authorization) {
  const { requested, clientId } = authorization
  const target = el(`${panel}-asked`)
  if (!requested) {
    target.innerHTML = ''
    return
  }
  const chips = requested.claims.map((claim) => `<span class="chip">${escapeHtml(claim)}</span>`).join(' ')
  target.innerHTML = `
    <h4>What is asked</h4>
    <div class="kv compact">
      <div><span>Purpose</span><span>${escapeHtml(requested.purpose)}</span></div>
      <div><span>Credential</span><code>${escapeHtml(requested.credentialType)}</code></div>
      <div><span>Claims</span><span>${chips}</span></div>
      ${clientId ? `<div><span>Verifier</span><code title="${escapeHtml(clientId)}">${escapeHtml(shorten(clientId))}</code></div>` : ''}
    </div>`
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

function showAuthPanel(panel, authorization, presentation) {
  const changed = auth[panel].request !== authorization.request
  auth[panel].request = authorization.request
  auth[panel].authorization = authorization
  auth[panel].delivery = authorization.delivery ?? (changed ? null : auth[panel].delivery)

  if (changed) {
    ui.renderQr(el(`${panel}-qr`), authorization.request)
    el(`${panel}-uri`).textContent = authorization.request
    el(`${panel}-simulate-note`).textContent = ''
  }

  const settled = FINAL_STATES.includes(authorization.state)
  renderAsked(panel, authorization)
  renderSteps(panel, authorization, presentation)
  renderCountdown(panel, authorization)
  // Once decided there is nothing left to present; the strip and what was asked stay as the record.
  el(`${panel}-ways`).hidden = settled
  el(`${panel}-auth`).classList.toggle('settled', settled)
  el(`${panel}-auth`).classList.toggle('refused', authorization.state === 'denied' || authorization.state === 'expired')
  renderSendButton(panel)
  renderDelivery(panel)
  el(`${panel}-auth`).hidden = false
}

function hideAuthPanel(panel) {
  auth[panel] = { request: null, delivery: null, authorization: null }
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

// ---------- tasks ----------

const TASK_BADGE = { completed: 'ok', failed: 'bad', 'auth-required': 'warn' }

async function loadTasks() {
  const response = await fetch('/api/tasks')
  if (!response.ok) return
  const data = await response.json()
  const tasks = data.tasks ?? []

  el('tasks-empty').hidden = tasks.length > 0
  el('tasks-list').innerHTML = tasks
    .map((task) => {
      const presentation = task.presentation
      const by =
        presentation?.outcome === 'authorized' && presentation.claims
          ? `Authorized by ${presentation.claims.role ?? '?'} · ${presentation.claims.org ?? '?'}`
          : presentation?.outcome === 'denied'
            ? 'Authorization denied'
            : ''
      return `
        <article class="card ${task.state === 'failed' ? 'refused' : ''}">
          <div>
            <h3>${escapeHtml(task.resource)}</h3>
            <div class="meta">
              <span>started ${escapeHtml(ui.formatWhen(task.startedAt))}</span>
              ${task.a2a ? `<span class="chip" title="${escapeHtml(task.a2a.taskId)}">task ${escapeHtml(task.a2a.taskId.slice(0, 8))}</span>` : ''}
              ${by ? `<span>${escapeHtml(by)}</span>` : ''}
              ${presentation?.source === 'simulated' ? '<span class="chip warn">simulated</span>' : ''}
            </div>
          </div>
          <div class="right">
            <span class="badge ${TASK_BADGE[task.state] ?? ''}">${escapeHtml(task.state)}</span>
            <div class="actions"><button data-open-task="${escapeHtml(task.id)}">Open</button></div>
          </div>
        </article>`
    })
    .join('')
}

// ---------- agent task ----------

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

  // An MCP server is not engaged with a task: its tools are on the MCP tab. Going there is the
  // engagement, and the fresh verdict travels along so the tab can say what was verified.
  if (data.kind === 'mcp') {
    el('mcp-engaged').hidden = false
    el('mcp-engaged').textContent =
      `${result?.displayName ?? identifier} — re-verified ${ui.formatWhen(data.verifiedAt)} · VERIFIED (${result?.publisher ?? ''}). Verified is not the same as unlocked: the sensitive tool below still demands a scope.`
    showView('mcp')
    return
  }

  watchTask(data.taskId)
}

const AUTH_TITLE = {
  authorized: 'Authorized',
  denied: 'Authorization denied',
  expired: 'Authorization expired',
}

function renderTask(task) {
  el('task-title').textContent = task.resource
  el('task-context').textContent = task.preflight
    ? `Re-verified ${ui.formatWhen(task.preflight.verifiedAt)} · ${task.preflight.verdict} — asking it to reconcile May invoices and prepare the payment export`
    : ''

  el('task-events').innerHTML = task.events
    .map(
      (event) => `<li class="${event.state === 'failed' ? 'bad' : event.state === 'completed' ? 'ok' : ''}">
          <div class="when">${escapeHtml(event.at)} · ${escapeHtml(event.state)}</div>
          ${escapeHtml(event.text ?? '')}
        </li>`
    )
    .join('')

  if (task.authorization) {
    el('task-auth-title').textContent = AUTH_TITLE[task.authorization.state] ?? 'Authorization required'
    showAuthPanel('task', task.authorization, task.presentation)
  } else {
    hideAuthPanel('task')
  }

  el('task-presentation').innerHTML = presentationCard(task.presentation)

  const result = el('task-result')
  if (task.result || task.error) {
    result.hidden = false
    result.className = `result ${task.error ? 'bad' : ''}`
    result.textContent = task.result ?? task.error
  } else {
    result.hidden = true
  }
}

/** Open a task and keep polling it until it is final — whatever view is visible meanwhile. */
function watchTask(taskId) {
  state.taskId = taskId
  el('task-title').textContent = ''
  el('task-context').textContent = ''
  el('task-events').innerHTML = ''
  el('task-presentation').innerHTML = ''
  el('task-result').hidden = true
  hideAuthPanel('task')
  showView('task')

  startPoller(
    'task',
    async () => {
      const response = await fetch(`/api/task/${taskId}`)
      if (!response.ok) {
        stopPoller('task')
        return
      }
      const task = await response.json()
      if (state.taskId !== taskId) return
      renderTask(task)
      if (task.state === 'completed' || task.state === 'failed') stopPoller('task')
    },
    1500
  )
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

  // The list refreshes only while it is on screen; task and step-up pollers keep running regardless.
  stopPoller('tasks')
  if (name === 'tasks') startPoller('tasks', loadTasks, 3000)
  if (name === 'audit') loadAudit()
  if (name === 'mcp') {
    loadTools()
    if (mcp.pending && !pollers.has('mcp-auth')) pollAuthorization()
  }
}

// ---------- MCP tools ----------

// The step-up in progress on this page: which tool to retry, and the authorization as last polled.
const mcp = { pending: null }
const token = { expiresAt: 0 }

const SESSION_STATE = {
  RequestCreated: 'requested',
  RequestUriRetrieved: 'wallet-fetched',
  ResponseVerified: 'verified',
}

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

/** With a status from the server the deadline is reset; without one the badge just counts down. */
function renderTokenStatus(status) {
  if (status) token.expiresAt = status.present ? Date.now() + status.expiresInSeconds * 1000 : 0
  const left = Math.max(0, Math.round((token.expiresAt - Date.now()) / 1000))
  const badge = el('token-status')
  if (left > 0) {
    badge.className = `badge ${left <= 30 ? 'warn' : 'ok'}`
    badge.textContent = `token · ${mmss(left)} left`
  } else {
    badge.className = 'badge'
    badge.textContent = 'no token'
  }
  el('token-drop').hidden = left <= 0
}

function mcpAuthorizationFrom(authorization) {
  return {
    request: authorization.request,
    sessionId: authorization.session?.id,
    state: SESSION_STATE[authorization.session?.state] ?? 'requested',
    requested: authorization.requested,
    delivery: authorization.delivery,
    source: authorization.source,
  }
}

async function invokeTool(name, { retry = false } = {}) {
  el('mcp-result').hidden = true
  // A settled panel from an earlier step-up is cleared by a fresh Invoke; a live one is joined.
  if (!retry && !mcp.pending) {
    hideAuthPanel('mcp')
    el('mcp-presentation').innerHTML = ''
  }

  const response = await fetch('/api/mcp/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: name }),
  })
  const data = await response.json()

  if (data.ok) {
    el('mcp-result').hidden = false
    const by = data.result?.authorizedBy
    el('mcp-result').className = 'result'
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
    mcp.pending = { tool: name, authorization: mcpAuthorizationFrom(data.authorization) }
    showAuthPanel('mcp', mcp.pending.authorization, null)
    pollAuthorization()
    return
  }

  el('mcp-result').hidden = false
  el('mcp-result').className = 'result bad'
  el('mcp-result').textContent = data.error ?? JSON.stringify(data, null, 2)
}

function pollAuthorization() {
  if (!mcp.pending) return
  startPoller(
    'mcp-auth',
    async () => {
      if (!mcp.pending) {
        stopPoller('mcp-auth')
        return
      }
      const response = await fetch('/api/mcp/authorization')
      const data = await response.json()

      // Nothing pending on the server (a restart, say): there is nothing to wait for.
      if (response.status === 409) {
        stopPoller('mcp-auth')
        mcp.pending = null
        hideAuthPanel('mcp')
        return
      }

      if (response.status === 403) {
        stopPoller('mcp-auth')
        el('mcp-auth-title').textContent = 'Authorization denied'
        showAuthPanel('mcp', { ...mcp.pending.authorization, state: 'denied' }, data.presentation)
        el('mcp-presentation').innerHTML = presentationCard(data.presentation)
        el('mcp-result').hidden = false
        el('mcp-result').className = 'result bad'
        el('mcp-result').textContent = data.error
        mcp.pending = null
        return
      }

      if (data.granted) {
        stopPoller('mcp-auth')
        const { tool, authorization } = mcp.pending
        mcp.pending = null
        el('mcp-auth-title').textContent = 'Authorized'
        showAuthPanel('mcp', { ...authorization, state: 'authorized', delivery: data.delivery }, data.presentation)
        renderTokenStatus(data.token)
        await invokeTool(tool, { retry: true }) // step-up complete: retry the original call
        el('mcp-presentation').innerHTML = presentationCard(data.presentation)
        return
      }

      // Keep the strip and the delivery line in step with what the server saw.
      const authorization = mcp.pending.authorization
      if (data.session) {
        authorization.sessionId = data.session.id
        authorization.state = SESSION_STATE[data.session.state] ?? authorization.state
      }
      if (data.delivery) authorization.delivery = data.delivery
      showAuthPanel('mcp', authorization, null)
    },
    2000
  )
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
  el('mcp-result').className = 'result'
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
        const evidence = event.evidence ?? {}
        const detail = evidence.failureDetail ?? evidence.note
        return `<li class="${tone(event)}">
          <div class="when">${escapeHtml(event.timestamp)} · ${escapeHtml(event.type)}</div>
          <strong>${escapeHtml(event.subject)}</strong> — ${escapeHtml(event.outcome)}
          ${detail ? `<div class="note">${escapeHtml(detail)}</div>` : ''}
          ${ui.renderEvidence(evidence, ['failureDetail', 'note'])}
          ${presentationCard(evidence.presentation, true)}
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

  const raw = event.target.closest('[data-raw-vp]')
  if (raw) openRawVp(presentations.get(raw.dataset.rawVp))

  const open = event.target.closest('[data-open-task]')
  if (open) watchTask(open.dataset.openTask)
})

el('task-simulate').addEventListener('click', simulatePresentation)
el('task-back').addEventListener('click', () => showView('tasks'))

el('mcp-simulate').addEventListener('click', simulateMcpPresentation)
el('token-drop').addEventListener('click', dropToken)
el('tools').addEventListener('click', (event) => {
  const button = event.target.closest('[data-tool]')
  if (button) invokeTool(button.dataset.tool)
})

document.querySelectorAll('.tab[data-view]').forEach((tab) => {
  tab.addEventListener('click', () => showView(tab.dataset.view))
})

// One clock for everything that counts down: the agent's timeout and the token's lifetime.
setInterval(() => {
  if (auth.task.authorization) renderCountdown('task', auth.task.authorization)
  renderTokenStatus()
}, 1000)

loadConfig()
loadWallet()
search(el('query').value)
