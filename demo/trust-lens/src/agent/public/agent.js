/* Acme Invoice Agent — server view: the relying party's own record, polled every 2 s while visible. */

const { el, escapeHtml, formatWhen } = ui

const POLL_MS = 2000
/** The agent's timeout denial; shown as Expired rather than Denied, as the Trust Lens does. */
const NO_PRESENTATION_IN_TIME = 'no presentation was received in time'
const STEPS = ['Requested', 'Wallet fetched', 'Verified', 'Status checked', 'Authorized']
const EVENT_TYPES = [
  'task.state',
  'auth.requested',
  'session.state',
  'auth.verified',
  'status.checked',
  'auth.authorized',
  'auth.denied',
  'channel.open',
  'channel.closed',
  'llm.fallback',
  'authorizations.cleared',
]

let view = 'overview'
let poller = null
/** Last rendered payloads, so a quiet tick does not rebuild the DOM under a text selection. */
const signatures = {}
/** The journal as the page knows it, newest first, grown with `since` polls. */
let events = []
let eventFilter = ''
let contexts = 0

const shorten = (value, head = 8) => (value && value.length > head + 4 ? `${value.slice(0, head)}…` : (value ?? ''))
const code = (value) => `<code title="${escapeHtml(value ?? '')}">${escapeHtml(value ?? '')}</code>`
const mmss = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

async function getJson(path) {
  const response = await fetch(path)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
  return data
}

/** Render only when the data changed. */
function changed(key, data) {
  const signature = JSON.stringify(data)
  if (signatures[key] === signature) return false
  signatures[key] = signature
  return true
}

// ---------- header ----------

function renderChannel(channel) {
  const chip = el('channel-chip')
  const label = { open: 'open', closed: 'reconnecting…', connecting: 'connecting…' }[channel.state] ?? channel.state
  const reconnects = channel.reconnects
    ? ` · ${channel.reconnects} reconnect${channel.reconnects === 1 ? '' : 's'}`
    : ''
  chip.className = `badge ${channel.state === 'open' ? 'ok' : 'warn'}`
  chip.textContent = `Heka notifications: ${label}${reconnects}`
  chip.title = `${channel.state} since ${formatWhen(channel.since)}${channel.lastError ? ` · last error: ${channel.lastError}` : ''}`
}

// ---------- overview ----------

const kv = (rows) =>
  rows
    .filter(Boolean)
    .map(([label, html]) => `<div><span>${escapeHtml(label)}</span><span>${html}</span></div>`)
    .join('')

function renderOverview(state) {
  contexts = state.counts.contexts
  if (!changed('overview', state)) return
  const { agent, trust, counts } = state

  el('counters').innerHTML = [
    ['Tasks', counts.tasks],
    ['Authorized', counts.authorized],
    ['Denied', counts.denied],
    ['Authorized contexts', counts.contexts],
  ]
    .map(([label, value]) => `<div class="counter"><strong>${value}</strong><span>${escapeHtml(label)}</span></div>`)
    .join('')

  el('identity-kv').innerHTML = kv([
    ['Agent', escapeHtml(agent.name)],
    ['Verifier DID', code(agent.verifierDid ?? '(not initialised)')],
    ['Resource DID', agent.resourceDid ? code(agent.resourceDid) : '<span class="note">not seeded</span>'],
    ['Public URL', code(agent.publicUrl)],
    ['Port', escapeHtml(String(agent.port))],
    ['Authorization timeout', `${escapeHtml(String(agent.authorizationTimeoutMs / 1000))} s`],
    ['LLM', agent.llm.enabled ? `on · ${escapeHtml(agent.llm.model ?? '')}` : 'off · deterministic report'],
    ['Started', escapeHtml(formatWhen(state.startedAt))],
  ])

  el('trust-kv').innerHTML = kv([
    [
      'Trusted issuer',
      trust.trustedIssuer ? code(trust.trustedIssuer) : '<span class="text-bad">none — run yarn seed</span>',
    ],
    ['Status lists', code(trust.statusListOrigin)],
    ['Verifier', 'Heka checks the signature and the key binding; this agent checks issuer, type, role and revocation'],
  ])
}

function renderCard(card) {
  if (!changed('card', card)) return
  el('card-note').innerHTML = `${escapeHtml(card.note)} Static card: ${code(card.staticCardUrl)}`
  el('card-json').textContent = JSON.stringify(card.live, null, 2)
}

async function loadOverview() {
  const [state, card] = await Promise.all([getJson('/api/state'), getJson('/api/card')])
  renderChannel(state.channel)
  renderOverview(state)
  renderCard(card)
}

// ---------- tasks ----------

const TASK_TONE = { completed: 'ok', failed: 'bad', canceled: 'bad', 'auth-required': 'warn' }

function taskCard(task) {
  const steps = task.steps
    .map(
      (step) => `<li class="${TASK_TONE[step.state] ?? ''}">
        <div class="when">${escapeHtml(formatWhen(step.at))} · ${escapeHtml(step.state)}</div>
        ${step.text ? escapeHtml(step.text) : ''}
      </li>`
    )
    .join('')
  const outcome = task.result
    ? `<pre class="raw">${escapeHtml(task.result)}</pre>`
    : task.error
      ? `<p class="refusal">${escapeHtml(task.error)}</p>`
      : ''
  return `
    <article class="card ${task.state === 'failed' || task.state === 'canceled' ? 'refused' : ''}">
      <div>
        <h3>Task ${escapeHtml(shorten(task.id))}</h3>
        <div class="meta">
          <span>context ${code(task.contextId)}</span>
          ${task.sessionId ? `<span class="chip">session ${escapeHtml(shorten(task.sessionId))}</span>` : ''}
          <span>started ${escapeHtml(formatWhen(task.startedAt))}</span>
        </div>
      </div>
      <div class="right"><span class="badge ${TASK_TONE[task.state] ?? ''}">${escapeHtml(task.state)}</span></div>
      <ol class="timeline">${steps}</ol>
      ${outcome}
    </article>`
}

async function loadTasks() {
  const data = await getJson('/api/tasks')
  if (!changed('tasks', data)) return
  el('task-list').innerHTML =
    data.tasks.map(taskCard).join('') || '<p class="empty">No task yet — engage the agent from the Trust Lens.</p>'
}

// ---------- authorizations ----------

/** How many steps are done; a denial after a status check has walked the whole strip. */
function stepProgress(record) {
  if (record.outcome === 'authorized') return 5
  if (record.outcome === 'denied') return record.status ? 4 : record.presentation ? 3 : 1
  return { RequestUriRetrieved: 2, ResponseVerified: 3 }[record.sessionState] ?? 1
}

function renderSteps(record) {
  const progress = stepProgress(record)
  const failed = record.outcome === 'denied'
  return STEPS.map((label, index) => {
    if (index === STEPS.length - 1 && failed) {
      return `<li class="bad">${record.reason === NO_PRESENTATION_IN_TIME ? 'Expired' : 'Denied'}</li>`
    }
    const cls = index < progress ? 'done' : index === progress ? 'current' : ''
    return `<li class="${cls}">${escapeHtml(label)}</li>`
  }).join('')
}

function countdown(record) {
  if (record.outcome) return ''
  const left = Math.max(0, Math.round((Date.parse(record.expiresAt) - Date.now()) / 1000))
  return `<p class="countdown ${left <= 30 ? 'bad' : ''}">${
    left > 0 ? `Agent timeout in ${mmss(left)}` : 'Agent timeout reached — denying on the next tick'
  }</p>`
}

function authorizationCard(record) {
  const denied = record.outcome === 'denied'
  const presentation = record.presentation
  const status = record.status
  const claims = Object.entries(presentation?.claims ?? {})
    .map(([name, value]) => `<span class="chip">${escapeHtml(name)} · ${escapeHtml(String(value))}</span>`)
    .join(' ')
  const statusText = status
    ? `${status.revoked ? 'revoked' : 'live'} · index ${status.statusListIndex} · checked ${formatWhen(status.checkedAt)}`
    : 'not checked'
  const badge = denied ? 'bad' : record.outcome ? 'ok' : 'warn'
  const label = record.outcome ? record.outcome.toUpperCase() : 'PENDING'

  return `
    <article class="card ${denied ? 'refused' : ''}">
      <div>
        <h3>Session ${escapeHtml(shorten(record.sessionId))} → task ${escapeHtml(shorten(record.taskId))}</h3>
        <div class="meta">
          <span>context ${code(record.contextId)}</span>
          <span>requested ${escapeHtml(formatWhen(record.requestedAt))}</span>
          <span class="chip">${escapeHtml(record.sessionState)}</span>
        </div>
      </div>
      <div class="right"><span class="badge ${badge}">${escapeHtml(label)}</span></div>
      <ol class="steps">${renderSteps(record)}</ol>
      ${countdown(record)}
      ${denied ? `<p class="refusal">${escapeHtml(record.reason ?? '')}</p>` : ''}
      <div class="kv compact">${kv([
        !denied && claims && ['Claims', claims],
        presentation?.credentialType && ['Credential', code(presentation.credentialType)],
        presentation?.issuer && ['Issuer', code(presentation.issuer)],
        presentation?.holder && ['Holder', code(presentation.holder)],
        [
          'Status',
          `<span class="${status?.revoked ? 'text-bad' : status ? 'text-ok' : ''}">${escapeHtml(statusText)}</span>`,
        ],
        record.verifiedAt && ['Verified', escapeHtml(formatWhen(record.verifiedAt))],
        record.decidedAt && ['Decided', escapeHtml(formatWhen(record.decidedAt))],
      ])}</div>
    </article>`
}

async function loadAuthorizations() {
  const [data, state] = await Promise.all([getJson('/api/authorizations'), getJson('/api/state')])
  renderChannel(state.channel)
  contexts = state.counts.contexts
  el('forget').disabled = contexts === 0 && el('forget-confirm').hidden
  el('forget').title = contexts === 0 ? 'No authorized context to forget' : ''
  // The countdown changes every tick, so there is no signature here: rebuild each poll.
  el('authorization-list').innerHTML =
    data.authorizations.map(authorizationCard).join('') || '<p class="empty">No authorization requested yet.</p>'
}

async function forget() {
  el('forget-confirm').hidden = true
  el('forget').disabled = true
  try {
    const response = await fetch('/api/authorizations/forget', { method: 'POST' })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
    el('forget-note').textContent =
      `Forgot ${data.cleared} context${data.cleared === 1 ? '' : 's'} — the next task in each asks again.`
  } catch (error) {
    el('forget-note').textContent = `Could not forget: ${error.message}`
  } finally {
    el('forget').disabled = false
  }
  loadAuthorizations()
}

// ---------- events ----------

function renderFilters() {
  el('event-filters').innerHTML = ['', ...EVENT_TYPES]
    .map(
      (type) =>
        `<button class="chip ${type === eventFilter ? 'active' : ''}" data-type="${escapeHtml(type)}">${escapeHtml(type || 'all')}</button>`
    )
    .join('')
}

const EVENT_TONE = {
  'auth.authorized': 'ok',
  'channel.open': 'ok',
  'auth.denied': 'bad',
  'channel.closed': 'bad',
  'llm.fallback': 'bad',
}

function renderEvents() {
  const shown = eventFilter ? events.filter((event) => event.type === eventFilter) : events
  el('event-list').innerHTML =
    shown
      .map(
        (event) => `<li class="${EVENT_TONE[event.type] ?? ''}">
          <div class="when">${escapeHtml(formatWhen(event.at))} · ${escapeHtml(event.type)}${
            event.taskId ? ` · task ${escapeHtml(shorten(event.taskId))}` : ''
          }${event.sessionId ? ` · session ${escapeHtml(shorten(event.sessionId))}` : ''}</div>
          ${escapeHtml(event.text)}
          ${ui.renderEvidence(event.data)}
        </li>`
      )
      .join('') || '<li class="note">Nothing recorded yet.</li>'
}

async function loadEvents() {
  const since = events[0]?.id
  const data = await getJson(since ? `/api/events?since=${encodeURIComponent(since)}` : '/api/events')
  // An unknown `since` (the agent restarted) returns everything: start over rather than duplicate.
  if (since && data.events.some((event) => event.id === since)) events = []
  if (!data.events.length && since) return
  events = [...data.events, ...events]
  renderEvents()
}

// ---------- polling ----------

const LOADERS = { overview: loadOverview, tasks: loadTasks, authorizations: loadAuthorizations, events: loadEvents }

async function tick() {
  if (document.hidden) return
  try {
    await LOADERS[view]()
    // Every view keeps the header honest, not just the overview.
    if (view !== 'overview' && view !== 'authorizations') renderChannel((await getJson('/health')).channel)
    el('load-error').hidden = true
  } catch (error) {
    el('load-error').hidden = false
    el('load-error').textContent = `Could not read the agent: ${error.message}`
  }
}

function showView(name) {
  view = name
  document.querySelectorAll('.view').forEach((section) => section.classList.toggle('active', section.id === name))
  document
    .querySelectorAll('.tab[data-view]')
    .forEach((tab) => tab.classList.toggle('active', tab.dataset.view === name))
  clearInterval(poller)
  tick()
  poller = setInterval(tick, POLL_MS)
}

// ---------- wiring ----------

document.querySelectorAll('.tab[data-view]').forEach((tab) => {
  tab.addEventListener('click', () => showView(tab.dataset.view))
})

el('forget').addEventListener('click', () => {
  el('forget-note').textContent = ''
  el('forget-question').textContent =
    `Clears ${contexts} authorized context${contexts === 1 ? '' : 's'}; the next task in those contexts will ask again.`
  el('forget-confirm').hidden = false
})
el('forget-yes').addEventListener('click', forget)
el('forget-no').addEventListener('click', () => {
  el('forget-confirm').hidden = true
})

el('event-filters').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-type]')
  if (!chip) return
  eventFilter = chip.dataset.type
  renderFilters()
  renderEvents()
})

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) tick()
})

renderFilters()
showView('overview')
