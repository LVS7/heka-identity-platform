/* Trust Lens UI. Deliberately dependency-free (one vendored QR encoder): the interesting part is the trust model. */

const state = {
  results: [],
  verdicts: new Map(),
  wallet: { linked: false },
  config: { trustedIssuers: [], trustedIssuerName: '' },
  taskId: null,
  /** The task as last rendered, so a poll that brings nothing new does not rewrite the view. */
  renderedTask: '',
  query: '',
}

const { el, escapeHtml } = ui

const VERDICT_CLASS = { VERIFIED: 'ok' }
const badgeClass = (verdict) => VERDICT_CLASS[verdict] ?? (verdict ? 'bad' : '')
const isAgent = (result) => result.type.includes('a2a')
/** An identifier is the publisher's own claim, so a verdict is kept per publisher and identifier. */
const keyOf = (result) => `${result.publisher}|${result.identifier}`
const FINAL_STATES = ['authorized', 'denied', 'expired', 'failed']
const shorten = (value, head = 24, tail = 6) =>
  value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value
const mmss = (seconds) =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`

const API_TIMEOUT_MS = 20_000
/** A first DIDComm send, wallet link or simulated presentation starts a Credo agent: seconds, more in Docker. */
const SLOW_TIMEOUT_MS = 120_000

/**
 * Every request goes through here. Bounded, tolerant of an HTML error page, and never throwing: it
 * answers like a Response whose json() always resolves, so a click whose request failed can say so
 * instead of dying in an unhandled rejection.
 */
async function api(url, init = {}) {
  const { timeoutMs = API_TIMEOUT_MS, ...options } = init
  let response
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    const data = { error: `request failed: ${error.message}` }
    return { ok: false, status: 0, json: async () => data }
  }
  const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
  return { ok: response.ok, status: response.status, json: async () => data }
}

/** One line under the header for a request that failed; an empty message clears it. */
function showError(message) {
  el('page-error').textContent = message ?? ''
  el('page-error').hidden = !message
}

async function loadConfig() {
  const response = await api('/api/config')
  if (response.ok) state.config = await response.json()
}

// ---------- polling that survives navigation ----------

// Task and step-up pollers outlive view switches — a pending task must not die because someone
// looked at another tab; the list and chat pollers are view-scoped.
const pollers = new Map()

function startPoller(key, tick, ms) {
  stopPoller(key)
  let running = false
  const guarded = async () => {
    // A slow answer must not overlap the next tick: two polls of one step-up could both settle it.
    if (running) return
    running = true
    try {
      await tick()
    } finally {
      running = false
    }
  }
  pollers.set(key, setInterval(guarded, ms))
  guarded()
}

function stopPoller(key) {
  clearInterval(pollers.get(key))
  pollers.delete(key)
}

// ---------- operator's wallet ----------

async function loadWallet() {
  const response = await api('/api/wallet')
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
  el('wallet-did').disabled = true
  el('wallet-link').textContent = 'Linking…'

  try {
    const response = await api('/api/wallet/link', {
      timeoutMs: SLOW_TIMEOUT_MS,
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
    el('wallet-did').disabled = false
    el('wallet-link').textContent = 'Link wallet'
  }
}

async function unlinkWallet() {
  const response = await api('/api/wallet/link', { method: 'DELETE' })
  const data = await response.json()
  if (!response.ok) {
    showError(`Unlink failed: ${data.error}`)
    return
  }
  showError('')
  state.wallet = data
  renderWallet()
}

// ---------- discovery ----------

async function search(query) {
  state.query = query
  if (el('query').value !== query) el('query').value = query
  // The query is part of the Discovery address, so a search is a step in the history too.
  if (el('discovery').classList.contains('active')) syncUrl('discovery')

  const response = await api(`/api/discovery?q=${encodeURIComponent(query)}`)
  const data = await response.json()
  showError(response.ok ? '' : `Discovery failed: ${data.error}`)

  state.results = data.results ?? []
  state.verdicts.clear()

  // A publisher that could not be read is said out loud: "nothing matches" would be a different claim.
  const unreachable = data.unreachable ?? []
  el('score-note').textContent = [
    state.results.length ? `Score: ${data.scoreMeaning}` : '',
    unreachable.length ? `Could not read: ${unreachable.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  el('empty').textContent = query.trim()
    ? `No published resource matches “${query.trim()}”.`
    : 'Search the registry to discover published resources.'
  el('verify-all').disabled = state.results.length === 0
  render()
}

function render() {
  const container = el('results')
  el('empty').hidden = state.results.length > 0

  container.innerHTML = state.results
    .map((result) => {
      const verdict = state.verdicts.get(keyOf(result))
      const badge = verdict
        ? `<span class="badge ${badgeClass(verdict.verdict)}">${escapeHtml(verdict.verdict)}</span>`
        : `<span class="badge">Not verified</span>`

      const engageable = verdict?.engageable
      const actions = verdict
        ? `<div class="actions">
             <button data-details="${escapeHtml(keyOf(result))}">Evidence</button>
             <button data-engage="${escapeHtml(keyOf(result))}" ${engageable ? '' : 'disabled'}>Engage</button>
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
    const response = await api('/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targets: state.results.map((r) => ({ identifier: r.identifier, publisher: r.publisher })),
      }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      showError(`Verify failed: ${data.error ?? `HTTP ${response.status}`}`)
      return
    }
    showError('')
    // A verdict from an earlier pass must not outlive a pass that could not reach its publisher.
    state.verdicts.clear()
    for (const result of data.results ?? []) state.verdicts.set(keyOf(result), result)
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

function openDrawer(key) {
  const result = state.results.find((r) => keyOf(r) === key)
  const verdict = state.verdicts.get(key)
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
  task: { request: null, delivery: null, authorization: null, sending: false },
  mcp: { request: null, delivery: null, authorization: null, sending: false },
}

const STEPS = ['Requested', 'Wallet fetched', 'Verified', 'Status checked', 'Authorized']
/** How the last step reads when the exchange ended without an authorization. */
const FAILED_LABEL = { denied: 'Denied', expired: 'Expired', failed: 'Failed' }

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
  const failed = ['denied', 'expired', 'failed'].includes(authorization.state)
  const progress = stepProgress(authorization, presentation)
  el(`${panel}-steps`).innerHTML = STEPS.map((label, index) => {
    if (index === STEPS.length - 1 && failed) {
      return `<li class="bad">${FAILED_LABEL[authorization.state]}</li>`
    }
    const cls = index < progress ? 'done' : index === progress && !failed ? 'current' : ''
    return `<li class="${cls}">${escapeHtml(label)}</li>`
  }).join('')
}

/** Only the A2A panel counts down: the agent has a deadline, the MCP step-up has none. */
function renderCountdown(panel, authorization) {
  const target = el(`${panel}-countdown`)
  if (!target) return
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
  const { delivery, sending } = auth[panel]
  // The panel re-renders on every poll; a send still in flight must stay visibly in flight.
  button.disabled = !linked || sending
  button.textContent = sending ? 'Sending…' : delivery ? 'Resend to wallet' : 'Send to wallet'
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
  el(`${panel}-auth`).classList.toggle('refused', ['denied', 'expired', 'failed'].includes(authorization.state))
  renderSendButton(panel)
  renderDelivery(panel)
  el(`${panel}-auth`).hidden = false
}

function hideAuthPanel(panel) {
  auth[panel] = { request: null, delivery: null, authorization: null, sending: false }
  el(`${panel}-auth`).hidden = true
  const outage = el(`${panel}-auth-unavailable`)
  if (outage) outage.textContent = ''
}

async function sendToWallet(panel) {
  auth[panel].sending = true
  renderSendButton(panel)

  try {
    const url = panel === 'task' ? `/api/task/${state.taskId}/send-to-wallet` : '/api/mcp/send-to-wallet'
    const response = await api(url, { method: 'POST', timeoutMs: SLOW_TIMEOUT_MS })
    const data = await response.json()
    auth[panel].delivery = data.delivery ?? { state: 'failed', at: new Date().toISOString(), error: data.error }
    renderDelivery(panel)
  } finally {
    auth[panel].sending = false
    renderSendButton(panel)
  }
}

// ---------- tasks ----------

const TASK_BADGE = { completed: 'ok', failed: 'bad', 'auth-required': 'warn' }

async function loadTasks() {
  const response = await api('/api/tasks')
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

/**
 * Engage a discovered resource — or, with `again`, the entry an earlier task came from, in that
 * task's context. The server re-verifies either way; the verdict this page holds is display only.
 */
async function engage(key, again, button) {
  const result = again ?? state.results.find((r) => keyOf(r) === key)
  if (!result) return

  // Re-verification takes seconds; a second click would start a second task.
  const label = button?.textContent
  if (button) {
    button.disabled = true
    button.textContent = 'Engaging…'
  }
  let response
  try {
    response = await api('/api/engage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: result.identifier, publisher: result.publisher, contextId: again?.contextId }),
    })
  } finally {
    if (button) {
      button.disabled = false
      button.textContent = label
    }
  }
  const data = await response.json()

  if (!response.ok) {
    showError(data.verdict ? `Engage refused: ${data.verdict} at engagement time — ${data.error}` : data.error)
    return
  }
  showError('')

  // An MCP server is not engaged with a task: its tools are on the MCP tab. Going there is the
  // engagement, and the fresh verdict travels along so the tab can say what was verified.
  if (data.kind === 'mcp') {
    el('mcp-engaged').hidden = false
    el('mcp-engaged').textContent =
      `${result.displayName} — re-verified ${ui.formatWhen(data.verifiedAt)} · VERIFIED (${result.publisher}). Verified is not the same as unlocked: the sensitive tool below still demands a scope, and every call re-verifies the server.`
    renderConnection(data.connected)
    showView('mcp')
    return
  }

  watchTask(data.taskId)
}

const AUTH_TITLE = {
  authorized: 'Authorized',
  denied: 'Authorization denied',
  expired: 'Authorization expired',
  failed: 'Authorization did not complete',
}

function renderTask(task) {
  el('task-title').textContent = task.resource

  // The agent remembers a context it authorized: running again there completes without asking —
  // until Forget authorizations on the agent's page, which makes it ask again.
  const again = el('task-again')
  again.hidden = !(task.state === 'completed' && task.a2a?.contextId)
  again.onclick = () =>
    engage(
      null,
      {
        identifier: task.identifier,
        publisher: task.publisher,
        displayName: task.resource,
        contextId: task.a2a?.contextId,
      },
      again
    )
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
  state.renderedTask = ''
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
      const response = await api(`/api/task/${taskId}`)
      // A stale link (tasks live in memory, so a restart forgets them) lands on the list instead of
      // an empty page. Replace rather than push: there is nothing to go back to.
      if (response.status === 404) {
        stopPoller('task')
        showView('tasks', true)
        return
      }
      // Anything else that failed is worth another try on the next tick.
      if (!response.ok) return
      const task = await response.json()
      if (state.taskId !== taskId) return
      // Rewriting the view on every 1.5 s tick would drop a text selection and replace the buttons.
      const signature = JSON.stringify(task)
      if (signature !== state.renderedTask) {
        state.renderedTask = signature
        renderTask(task)
      }
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
    const response = await api(`/api/task/${state.taskId}/simulate-presentation`, {
      method: 'POST',
      timeoutMs: SLOW_TIMEOUT_MS,
    })
    const data = await response.json()
    el('task-simulate-note').textContent = response.ok ? 'Presented by the in-process holder.' : data.error
  } finally {
    button.disabled = false
  }
}

// ---------- routing ----------

// Every view has a path so it can be linked and reloaded; Discovery carries its query and the open
// task carries its id. The server answers all of these with the same page, and the tab that owns
// the path stays highlighted for the task view too, since a task is reached through the Tasks list.
const VIEW_TITLE = { discovery: 'Discovery', tasks: 'Tasks', task: 'Task', mcp: 'MCP tools', audit: 'Audit' }

function pathFor(name) {
  if (name === 'task') return `/tasks/${encodeURIComponent(state.taskId)}`
  if (name === 'discovery' && state.query) return `/discovery?q=${encodeURIComponent(state.query)}`
  return `/${name}`
}

/** Bring the address in line with the view. Back/forward and the first load must not add entries. */
function syncUrl(name, replace = false) {
  const path = pathFor(name)
  if (location.pathname + location.search === path) return
  history[replace ? 'replaceState' : 'pushState'](null, '', path)
}

/** Open whatever the current URL points at; unknown paths fall back to Discovery. */
function openPath(pathname, replace = false) {
  const task = pathname.match(/^\/tasks\/([^/]+)$/)
  if (task) return watchTask(decodeURIComponent(task[1]))
  const name = pathname.replace(/^\//, '')
  if (name in VIEW_TITLE && name !== 'task' && name !== 'discovery') return showView(name, replace)

  // A Discovery address without a query keeps whatever was searched last.
  const query = new URLSearchParams(location.search).get('q')
  if (query !== null && query !== state.query) search(query)
  showView('discovery', replace)
}

function showView(name, replace = false) {
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === name))
  const tab = name === 'task' ? 'tasks' : name
  document
    .querySelectorAll('.tab[data-view]')
    .forEach((link) => link.classList.toggle('active', link.dataset.view === tab))
  document.title = `Trust Lens · ${VIEW_TITLE[name]}`
  // The MCP tab fits the window and scrolls only inside the chat (app.css, body.view-mcp).
  document.body.classList.toggle('view-mcp', name === 'mcp')
  syncUrl(name, replace)

  // The list refreshes only while it is on screen; task and step-up pollers keep running regardless.
  stopPoller('tasks')
  if (name === 'tasks') startPoller('tasks', loadTasks, 3000)
  if (name === 'audit') loadAudit()
  if (name === 'mcp') {
    loadTools()
    startPoller('chat', loadChat, 1500)
    if (mcp.pending && !pollers.has('mcp-auth')) pollAuthorization()
  } else if (!chat.busy) {
    stopPoller('chat')
  }
}

// ---------- MCP tools ----------

// The step-up in progress on this page — always the chat's, since the chat is the only client on
// the page — and the authorization as last polled.
const mcp = { pending: null }
const token = { expiresAt: 0 }
const chat = { busy: false, rendered: '' }

function renderConnection(connected) {
  const line = el('mcp-connection')
  if (!connected) {
    line.textContent = ''
    return
  }
  line.innerHTML = `connected to <code>${escapeHtml(connected.url)}</code> (${
    connected.source === 'verified card' ? 'from the verified card' : 'env fallback'
  })`
}

async function loadTools() {
  const response = await api('/api/mcp/tools')
  const data = await response.json()

  if (!response.ok) {
    el('mcp-tools').textContent = data.reason ?? data.error
    if (response.status === 403) renderConnection(null)
    return
  }

  renderTokenStatus(data.token)
  renderConnection(data.connected)

  // Read-only: which tools exist and which one needs a scope is the least-privilege argument; the
  // chat is what calls them.
  const tools = (data.tools ?? []).map(
    (tool) =>
      `<code>${escapeHtml(tool.name)}</code> · ${tool.requiredScope ? `scope ${escapeHtml(tool.requiredScope)}` : 'no scope'}`
  )
  el('mcp-tools').innerHTML = tools.length ? `Tools on this server: ${tools.join(', ')}` : ''
}

/** With a status from the server the deadline is reset; without one the badge just counts down. */
function renderTokenStatus(status) {
  if (status) token.expiresAt = status.present ? Date.now() + status.expiresInSeconds * 1000 : 0
  const left = Math.max(0, Math.round((token.expiresAt - Date.now()) / 1000))
  const badge = el('token-status')
  if (left > 0) {
    badge.className = `badge ${left <= 30 ? 'warn' : 'ok'}`
    badge.textContent = `token · ${mmss(left)} left`
    el('token-note').textContent = '' // a fresh token makes the "dropped" note stale
  } else {
    badge.className = 'badge'
    badge.textContent = 'no token'
  }
  el('token-drop').hidden = left <= 0
}

/** The auth panel sits inside the paused chat step, and goes home between step-ups. */
function placeAuthPanel(slot) {
  const panel = el('mcp-auth')
  const target = slot ?? el('mcp-auth-home')
  if (panel.parentElement !== target) target.appendChild(panel)
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
      const response = await api('/api/mcp/authorization')
      const data = await response.json().catch(() => ({}))

      // Nothing pending on the server (a restart, say): there is nothing to wait for.
      if (response.status === 409) {
        stopPoller('mcp-auth')
        mcp.pending = null
        hideAuthPanel('mcp')
        return
      }

      // The AS or Heka is down, or this request failed: nothing was decided, so keep waiting and say why.
      if (!response.ok && ![403, 409, 410].includes(response.status)) {
        el('mcp-auth-unavailable').textContent = `Authorization server unavailable — retrying: ${data.error ?? ''}`
        return
      }
      el('mcp-auth-unavailable').textContent = ''

      // Over — granted, denied (403), or lost (410): the server has resumed the chat, and the paused
      // step shows the outcome (retried with the presentation card, or denied).
      if (data.granted || response.status === 403 || response.status === 410) {
        stopPoller('mcp-auth')
        mcp.pending = null
        if (data.granted) renderTokenStatus(data.token)
        hideAuthPanel('mcp')
        loadChat()
        return
      }

      // Keep the strip and the delivery line in step with what the server saw.
      if (data.authorization) mcp.pending.authorization = data.authorization
      showAuthPanel('mcp', mcp.pending.authorization, null)
    },
    2000
  )
}

async function simulateMcpPresentation() {
  const button = el('mcp-simulate')
  button.disabled = true
  el('mcp-simulate-note').textContent = 'Presenting…'

  try {
    const response = await api('/api/mcp/simulate-presentation', { method: 'POST', timeoutMs: SLOW_TIMEOUT_MS })
    const data = await response.json()
    el('mcp-simulate-note').textContent = response.ok ? 'Presented by the in-process holder.' : data.error
  } finally {
    button.disabled = false
  }
}

async function dropToken() {
  const response = await api('/api/mcp/token', { method: 'DELETE' })
  const data = await response.json()
  if (!response.ok) {
    showError(`Drop token failed: ${data.error}`)
    return
  }
  renderTokenStatus(data.token)
  el('token-note').textContent =
    'Cached token dropped. The next sensitive call has to authorize again — against the credential as it stands now.'
}

// ---------- chat ----------

const CHAT_STATUS = {
  thinking: 'Thinking…',
  'calling-tool': 'Calling a tool…',
  'paused-authorization': 'Paused — the tool needs a scope. Present the credential in the step above.',
}
const STEP_TONE = { ok: 'ok', retried: 'ok', paused: 'warn', denied: 'bad', refused: 'bad', error: 'bad', running: '' }

function toolStepText(tool) {
  const by = tool.authorizedBy
  switch (tool.status) {
    case 'running':
      return 'running…'
    case 'ok':
      return `ok · ${escapeHtml(tool.summary ?? '')}`
    case 'paused':
      return `paused: ${escapeHtml(tool.summary ?? 'authorization required')}`
    case 'retried':
      return `retried · ${by?.role ? `Authorized by ${escapeHtml(by.role)} · ${escapeHtml(by.org ?? '')}` : escapeHtml(tool.summary ?? '')}`
    default:
      return escapeHtml(tool.summary ?? tool.status)
  }
}

function renderChatStep(step) {
  const who = step.kind === 'user' ? 'you' : step.kind
  const when = `<div class="when">${escapeHtml(ui.formatWhen(step.at))} · ${who}</div>`
  if (step.kind !== 'tool') {
    return `<li class="${step.kind}">${when}${escapeHtml(step.text ?? '')}</li>`
  }
  const tool = step.tool
  const scope = tool.requiredScope ? `scope ${escapeHtml(tool.requiredScope)}` : 'no scope'
  return `<li class="tool ${STEP_TONE[tool.status] ?? ''}">
      ${when}
      <code>→ ${escapeHtml(tool.name)}</code> · ${scope} · <span class="step-${escapeHtml(tool.status)}">${toolStepText(tool)}</span>
      ${tool.status === 'paused' ? '<div class="auth-slot"></div>' : ''}
      ${presentationCard(tool.presentation)}
    </li>`
}

async function loadChat() {
  const response = await api('/api/chat')
  if (!response.ok) return
  const view = await response.json()
  renderChat(view)
}

function renderChat(view) {
  chat.busy = ['thinking', 'calling-tool', 'paused-authorization'].includes(view.state)
  el('chat-unavailable').hidden = view.available
  el('chat-unavailable').textContent = view.available ? '' : view.reason
  el('chat-send').disabled = !view.available || !view.engaged || chat.busy
  el('chat-input').disabled = !view.available || !view.engaged
  el('chat-input').placeholder = view.engaged
    ? 'Which invoices are held?'
    : 'Verify and engage Acme Invoice Data on Discovery first'

  const status = el('chat-status')
  status.className = `note ${view.state === 'error' ? 'text-bad' : ''}`
  status.textContent = view.state === 'error' ? `Error: ${view.error}` : (CHAT_STATUS[view.state] ?? '')

  // The poll runs every 1.5 s; rewriting the transcript each time would reset the person's scroll
  // and move the panel home and back. Rewrite only when the conversation changed.
  const paused = view.state === 'paused-authorization' && view.authorization
  const key = JSON.stringify([view.state, view.steps])
  if (key !== chat.rendered) {
    chat.rendered = key
    const scroller = el('chat-scroll')
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40
    // The panel lives inside the paused step; innerHTML would destroy it, so it goes home before
    // the rewrite and into the fresh slot after.
    placeAuthPanel(null)
    el('chat-steps').innerHTML = (view.steps ?? []).map(renderChatStep).join('')
    if (paused) placeAuthPanel(el('chat-steps').querySelector('.auth-slot'))
    // Follow the conversation only if the person was following it, not reading further up.
    if (atBottom) scroller.scrollTop = scroller.scrollHeight
  }

  if (paused && !mcp.pending?.chat) {
    el('mcp-auth-title').textContent = `Authorization required — ${view.authorization.scope}`
    el('mcp-auth-message').textContent = view.authorization.message ?? ''
    mcp.pending = { chat: true, authorization: view.authorization }
    showAuthPanel('mcp', mcp.pending.authorization, null)
    pollAuthorization()
    // A new pause is brought into view even if the person had scrolled up: it waits for them.
    const step = el('chat-steps').querySelector('.auth-slot')?.closest('li')
    if (step) el('chat-scroll').scrollTop = step.offsetTop - 8
  }
}

async function sendChat() {
  const input = el('chat-input')
  const message = input.value.trim()
  if (!message) return
  const response = await api('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  })
  if (response.ok) {
    input.value = ''
  } else {
    const data = await response.json()
    el('chat-status').className = 'note text-bad'
    el('chat-status').textContent = data.reason ?? data.error
  }
  startPoller('chat', loadChat, 1500)
}

async function resetChat() {
  const response = await api('/api/chat/reset', { method: 'POST' })
  if (!response.ok) {
    showError(`New chat failed: ${(await response.json()).error}`)
    return
  }
  if (mcp.pending?.chat) {
    stopPoller('mcp-auth')
    mcp.pending = null
    hideAuthPanel('mcp')
  }
  loadChat()
}

// ---------- audit ----------

async function loadAudit() {
  const response = await api('/api/audit')
  const data = await response.json()
  if (!response.ok) showError(`Could not read the audit: ${data.error}`)

  // A refusal is as much a trust decision as an approval; colour by what happened, not by type.
  const REFUSALS = ['denial', 'engagement_refused']
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
  if (engageTarget && !engageTarget.disabled) engage(engageTarget.dataset.engage, undefined, engageTarget)
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
el('chat-form').addEventListener('submit', (event) => {
  event.preventDefault()
  sendChat()
})
el('chat-reset').addEventListener('click', resetChat)

document.querySelectorAll('.tab[data-view]').forEach((tab) => {
  tab.addEventListener('click', (event) => {
    // Plain clicks stay in the page; modified clicks keep the link's open-in-new-tab behaviour.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
    event.preventDefault()
    showView(tab.dataset.view)
  })
})

window.addEventListener('popstate', () => openPath(location.pathname, true))

// One clock for everything that counts down: the agent's timeout and the token's lifetime.
setInterval(() => {
  if (auth.task.authorization) renderCountdown('task', auth.task.authorization)
  renderTokenStatus()
}, 1000)

loadConfig()
loadWallet()
// The address wins over the input's default query, whichever view it opens on.
const initialQuery = new URLSearchParams(location.search).get('q')
search(initialQuery ?? el('query').value)
// The root has no view of its own; land on Discovery without leaving a spare history entry behind.
if (location.pathname === '/') history.replaceState(null, '', '/discovery')
openPath(location.pathname, true)
