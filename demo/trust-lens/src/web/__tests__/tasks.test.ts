import { TaskStatusUpdateEvent } from '@a2a-js/sdk'
import { describe, expect, it } from 'vitest'

import { IN_TASK_OID4VP_EXTENSION_URI, InTaskOpenId4VpMessageMetadata } from '../../agent/extension'
import { applyStatusUpdate, TrackedTask } from '../tasks'

const REQUESTED = {
  purpose: 'Authorize the export',
  credentialType: 'urn:heka:role-credential:v1',
  claims: ['role', 'org'],
}

function update(
  state: TaskStatusUpdateEvent['status']['state'],
  text: string,
  metadata?: InTaskOpenId4VpMessageMetadata
): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId: 'agent-task',
    contextId: 'agent-context',
    final: state === 'completed' || state === 'failed',
    status: {
      state,
      timestamp: '2026-09-28T10:00:00.000Z',
      message: {
        kind: 'message',
        role: 'agent',
        messageId: 'm1',
        parts: [{ kind: 'text', text }],
        ...(metadata ? { metadata: { [IN_TASK_OID4VP_EXTENSION_URI]: metadata } } : {}),
      },
    },
  }
}

const fresh = (): TrackedTask => ({
  id: 't1',
  resource: 'Acme Invoice Agent',
  state: 'submitted',
  startedAt: '2026-09-28T09:59:59.000Z',
  events: [],
})

const authRequired = () =>
  update('auth-required', 'Present a credential.', {
    authorizationRequest: { client_id: 'did:key:verifier', request_uri: 'openid4vp://?request_uri=x' },
    authorizationStatus: {
      sessionId: 'sess-1',
      state: 'RequestCreated',
      expiresAt: '2026-09-28T10:03:00.000Z',
      requested: REQUESTED,
    },
  })

const statusUpdate = (state: string, text: string) =>
  update('working', text, {
    authorizationStatus: { sessionId: 'sess-1', state, expiresAt: '2026-09-28T10:03:00.000Z', requested: REQUESTED },
  })

describe('applyStatusUpdate', () => {
  it('opens the authorization from auth-required with what is asked and when it expires', () => {
    const task = fresh()
    applyStatusUpdate(task, authRequired())

    expect(task.state).toBe('auth-required')
    expect(task.events).toHaveLength(1)
    expect(task.authorization).toEqual({
      request: 'openid4vp://?request_uri=x',
      clientId: 'did:key:verifier',
      sessionId: 'sess-1',
      state: 'requested',
      expiresAt: '2026-09-28T10:03:00.000Z',
      requested: REQUESTED,
    })
  })

  it('moves the state on each working update and infers a scan when nothing was pressed', () => {
    const task = fresh()
    applyStatusUpdate(task, authRequired())
    applyStatusUpdate(task, statusUpdate('RequestUriRetrieved', 'The wallet fetched the request.'))

    expect(task.authorization?.state).toBe('wallet-fetched')
    expect(task.authorization?.source).toBe('qr')
  })

  it('keeps the source the Trust Lens set', () => {
    const task = fresh()
    applyStatusUpdate(task, authRequired())
    task.authorization!.source = 'wallet'
    applyStatusUpdate(
      task,
      statusUpdate('ResponseVerified', 'Presentation verified; checking the credential’s status.')
    )

    expect(task.authorization).toMatchObject({ state: 'verified', source: 'wallet' })
  })

  it('settles as authorized with the presentation on completed', () => {
    const task = fresh()
    applyStatusUpdate(task, authRequired())
    task.authorization!.source = 'simulated'
    applyStatusUpdate(
      task,
      update('completed', 'Payment export prepared.', {
        authorizationResult: {
          sessionId: 'sess-1',
          outcome: 'authorized',
          claims: { role: 'Finance Data Officer' },
          vpToken: 'ey',
        },
      })
    )

    expect(task.result).toBe('Payment export prepared.')
    expect(task.authorization?.state).toBe('authorized')
    expect(task.presentation).toMatchObject({
      outcome: 'authorized',
      source: 'simulated',
      claims: { role: 'Finance Data Officer' },
    })
  })

  it('settles as denied with the refused presentation on failed', () => {
    const task = fresh()
    applyStatusUpdate(task, authRequired())
    applyStatusUpdate(
      task,
      update('failed', 'Authorization denied: revoked', {
        authorizationResult: { sessionId: 'sess-1', outcome: 'denied', reason: 'revoked', vpToken: 'ey' },
      })
    )

    expect(task.error).toBe('Authorization denied: revoked')
    expect(task.authorization?.state).toBe('denied')
    expect(task.presentation).toMatchObject({ outcome: 'denied', source: 'qr' })
  })

  it('settles as expired when the agent gave up waiting', () => {
    const task = fresh()
    applyStatusUpdate(task, authRequired())
    applyStatusUpdate(
      task,
      update('failed', 'Authorization denied: no presentation was received in time', {
        authorizationResult: {
          sessionId: 'sess-1',
          outcome: 'denied',
          reason: 'no presentation was received in time',
        },
      })
    )

    expect(task.authorization?.state).toBe('expired')
    expect(task.presentation?.source).toBe('unknown')
  })

  it('leaves a task without the extension untouched beyond state and events', () => {
    const task = fresh()
    applyStatusUpdate(task, update('working', 'Reconciling…'))

    expect(task.authorization).toBeUndefined()
    expect(task.events[0]).toEqual({ at: '2026-09-28T10:00:00.000Z', state: 'working', text: 'Reconciling…' })
  })
})
