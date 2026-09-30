/**
 * Pushing an authorization request to the operator's wallet, from the orchestrator's side.
 *
 * Shared by the A2A task panel and the MCP step-up: both end up with an OID4VP request string
 * and a person who has to see it on their phone. Delivery is not a trust decision — a message
 * that fails to reach the phone denies nothing — so it is audited as an `authorization` step,
 * never as a `denial`, and a failure is reported rather than thrown so the UI can offer a resend
 * (or the QR / simulated paths) instead of a dead end.
 */

import { AuditLog } from '../core/audit'

export interface DeliveryState {
  state: 'sent' | 'failed'
  at: string
  attempts: number
  error?: string
}

export async function deliverToWallet(options: {
  subject: string
  content: string
  deliver: (content: string) => Promise<void>
  audit: AuditLog
  previous?: DeliveryState
}): Promise<DeliveryState> {
  const attempts = (options.previous?.attempts ?? 0) + 1
  const at = new Date().toISOString()

  try {
    await options.deliver(options.content)
    options.audit.record('authorization', options.subject, "authorization request delivered to the operator's wallet", {
      via: 'DIDComm basic message',
      attempt: attempts,
    })
    return { state: 'sent', at, attempts }
  } catch (error) {
    const message = (error as Error).message
    options.audit.record('authorization', options.subject, `wallet delivery failed: ${message}`, {
      via: 'DIDComm basic message',
      attempt: attempts,
    })
    return { state: 'failed', at, attempts, error: message }
  }
}
