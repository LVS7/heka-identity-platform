import { describe, expect, it } from 'vitest'

import { NO_PRESENTATION_IN_TIME } from '../../shared/authorization-result'
import { AgentState } from '../state'

const STATUS = {
  statusListCredential: 'http://localhost:3000/credentials/status/list-1',
  statusListIndex: 3,
  revoked: false,
  checkedAt: '2026-09-28T10:00:05.000Z',
}

function requested(state: AgentState, sessionId = 'sess-1', taskId = 't1', contextId = 'c1') {
  state.taskStep(taskId, contextId, 'submitted')
  state.taskStep(taskId, contextId, 'working', 'Reconciling…')
  state.taskStep(taskId, contextId, 'auth-required', 'Present a credential.')
  state.authorizationRequested({ sessionId, taskId, contextId, expiresAt: '2026-09-28T10:03:00.000Z' })
}

const types = (state: AgentState) => state.journal.list().map((event) => event.type)

describe('AgentState tasks', () => {
  it('indexes a task from its steps and keeps the result or the error', () => {
    const state = new AgentState()
    state.taskStep('t1', 'c1', 'submitted')
    state.taskStep('t1', 'c1', 'working', 'Reconciling…')
    state.taskStep('t1', 'c1', 'completed', 'Payment export prepared.')
    state.taskStep('t2', 'c2', 'submitted')
    state.taskStep('t2', 'c2', 'failed', 'Agent error: boom')

    const [newest, oldest] = state.listTasks()
    expect(oldest).toMatchObject({ id: 't1', contextId: 'c1', state: 'completed', result: 'Payment export prepared.' })
    expect(oldest.steps.map((step) => step.state)).toEqual(['submitted', 'working', 'completed'])
    expect(newest).toMatchObject({ id: 't2', state: 'failed', error: 'Agent error: boom' })
    expect(types(state).filter((type) => type === 'task.state')).toHaveLength(5)
    expect(state.journal.list()[0]).toMatchObject({ taskId: 't2', contextId: 'c2', text: 'failed: Agent error: boom' })
  })
})

describe('AgentState authorizations', () => {
  it('records the request on the task and journals it with the deadline', () => {
    const state = new AgentState()
    requested(state)

    expect(state.tasks.get('t1')?.sessionId).toBe('sess-1')
    expect(state.listAuthorizations()[0]).toMatchObject({
      sessionId: 'sess-1',
      taskId: 't1',
      contextId: 'c1',
      sessionState: 'RequestCreated',
      expiresAt: '2026-09-28T10:03:00.000Z',
    })
    expect(state.journal.list()[0]).toMatchObject({ type: 'auth.requested', sessionId: 'sess-1', taskId: 't1' })
    expect(state.isDecided('sess-1')).toBe(false)
  })

  it('follows the session, journals verification once, and ignores sessions it did not open', () => {
    const state = new AgentState()
    requested(state)
    state.sessionState('sess-1', 'RequestUriRetrieved')
    state.sessionState('sess-1', 'RequestUriRetrieved')
    state.sessionState('sess-1', 'ResponseVerified')
    state.sessionState('someone-elses', 'ResponseVerified')

    const record = state.authorizations.get('sess-1')
    expect(record?.sessionState).toBe('ResponseVerified')
    expect(record?.verifiedAt).toBeDefined()
    expect(types(state).slice(0, 3)).toEqual(['auth.verified', 'session.state', 'session.state'])
    expect(state.authorizations.has('someone-elses')).toBe(false)
  })

  it('keeps the status check and the authorized presentation, and remembers the context', () => {
    const state = new AgentState()
    requested(state)
    state.sessionState('sess-1', 'ResponseVerified')
    state.statusChecked('sess-1', STATUS)
    state.authorizationDecided({
      sessionId: 'sess-1',
      outcome: 'authorized',
      claims: { role: 'Finance Data Officer', org: 'Acme Corp GmbH' },
      issuer: 'did:hedera:testnet:trustco',
      holder: 'did:key:z6MkHolder#key-1',
      credentialType: 'urn:heka:role-credential:v1',
      status: STATUS,
      vpToken: 'eyJ.secret.token~',
      verifiedAt: '2026-09-28T10:00:04.000Z',
    })

    const record = state.authorizations.get('sess-1')
    expect(record).toMatchObject({ outcome: 'authorized', status: STATUS })
    expect(record?.presentation).toEqual({
      claims: { role: 'Finance Data Officer', org: 'Acme Corp GmbH' },
      issuer: 'did:hedera:testnet:trustco',
      holder: 'did:key:z6MkHolder#key-1',
      credentialType: 'urn:heka:role-credential:v1',
      verifiedAt: '2026-09-28T10:00:04.000Z',
    })
    expect(JSON.stringify(record)).not.toContain('secret.token')
    expect(state.authorizedContexts.has('c1')).toBe(true)
    expect(state.isDecided('sess-1')).toBe(true)
    expect(types(state).slice(0, 2)).toEqual(['auth.authorized', 'status.checked'])
    expect(state.journal.list()[1].data).toEqual({
      statusListCredential: STATUS.statusListCredential,
      statusListIndex: 3,
      revoked: false,
    })
    expect(state.counts()).toEqual({ tasks: 1, authorized: 1, denied: 0, contexts: 1 })
  })

  it('records a denial with what was verified but without claims, and a timeout as a denial', () => {
    const state = new AgentState()
    requested(state)
    state.authorizationDecided({
      sessionId: 'sess-1',
      outcome: 'denied',
      reason: 'the Finance Data Officer credential has been revoked by its issuer',
      issuer: 'did:hedera:testnet:trustco',
      holder: 'did:key:z6MkHolder#key-1',
      credentialType: 'urn:heka:role-credential:v1',
      status: { ...STATUS, revoked: true },
      vpToken: 'eyJ.secret.token~',
    })
    requested(state, 'sess-2', 't2', 'c2')
    state.authorizationDecided({ sessionId: 'sess-2', outcome: 'denied', reason: NO_PRESENTATION_IN_TIME })

    const revoked = state.authorizations.get('sess-1')
    expect(revoked).toMatchObject({ outcome: 'denied', reason: expect.stringContaining('revoked') })
    expect(revoked?.presentation).toEqual({
      claims: undefined,
      issuer: 'did:hedera:testnet:trustco',
      holder: 'did:key:z6MkHolder#key-1',
      credentialType: 'urn:heka:role-credential:v1',
      verifiedAt: undefined,
    })
    expect(revoked?.status?.revoked).toBe(true)
    expect(state.authorizations.get('sess-2')).toMatchObject({ outcome: 'denied', reason: NO_PRESENTATION_IN_TIME })
    expect(state.authorizations.get('sess-2')?.presentation).toBeUndefined()
    expect(state.authorizedContexts.size).toBe(0)
    expect(state.journal.list()[0]).toMatchObject({
      type: 'auth.denied',
      sessionId: 'sess-2',
      data: { reason: NO_PRESENTATION_IN_TIME },
    })
    expect(state.counts()).toEqual({ tasks: 2, authorized: 0, denied: 2, contexts: 0 })
  })

  it('forgets the authorized contexts and says how many', () => {
    const state = new AgentState()
    state.authorizedContexts.add('c1').add('c2')

    expect(state.forgetAuthorizations()).toBe(2)
    expect(state.authorizedContexts.size).toBe(0)
    expect(state.journal.list()[0]).toMatchObject({ type: 'authorizations.cleared', data: { cleared: 2 } })
    expect(state.forgetAuthorizations()).toBe(0)
  })
})

describe('AgentState lifecycle', () => {
  it('closes a pending authorization when its task is cancelled', () => {
    const state = new AgentState()
    requested(state)
    state.cancelPendingAuthorization('t1')

    expect(state.isDecided('sess-1')).toBe(true)
    expect(state.authorizations.get('sess-1')).toMatchObject({ outcome: 'denied', reason: 'task cancelled' })
  })

  it('records a presentation that arrives after the decision as ignored, without a verifiedAt', () => {
    const state = new AgentState()
    requested(state)
    state.authorizationDecided({ sessionId: 'sess-1', outcome: 'denied', reason: NO_PRESENTATION_IN_TIME })
    state.sessionState('sess-1', 'ResponseVerified')

    expect(state.authorizations.get('sess-1')?.verifiedAt).toBeUndefined()
    expect(state.journal.list()[0].text).toMatch(/after the agent stopped waiting/)
    expect(types(state)).not.toContain('auth.verified')
  })
})

describe('AgentState channel', () => {
  it('counts reconnects, keeps the last error until the channel reopens, and journals open/closed', () => {
    const state = new AgentState()
    expect(state.channel).toMatchObject({ state: 'connecting', reconnects: 0 })

    state.channelState('open')
    expect(state.channel).toMatchObject({ state: 'open', reconnects: 0 })

    state.channelError('socket hang up')
    state.channelState('closed', 'code 1006')
    expect(state.channel).toMatchObject({ state: 'closed', reconnects: 0, lastError: 'socket hang up' })

    state.channelState('connecting')
    expect(state.channel).toMatchObject({ state: 'connecting', lastError: 'socket hang up' })

    state.channelState('open')
    expect(state.channel).toMatchObject({ state: 'open', reconnects: 1 })
    expect(state.channel.lastError).toBeUndefined()
    expect(types(state)).toEqual(['channel.open', 'channel.closed', 'channel.open'])
    expect(state.journal.list()[1].text).toBe('notification channel closed (code 1006)')
  })

  it('journals one close per outage, not one per failed reconnect', () => {
    const state = new AgentState()
    state.channelState('open')
    for (let attempt = 0; attempt < 5; attempt++) {
      state.channelState('closed', 'code 1006')
      state.channelState('connecting')
    }
    expect(types(state).filter((type) => type === 'channel.closed')).toHaveLength(1)

    state.channelState('open')
    state.channelState('closed', 'code 1006')
    expect(types(state).filter((type) => type === 'channel.closed')).toHaveLength(2)
  })

  it('journals an LLM fallback against the task', () => {
    const state = new AgentState()
    state.llmFallback('t1', 'c1', 'connect ECONNREFUSED')
    expect(state.journal.list()[0]).toMatchObject({
      type: 'llm.fallback',
      taskId: 't1',
      contextId: 'c1',
      data: { reason: 'connect ECONNREFUSED' },
    })
  })
})
