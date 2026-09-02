/**
 * Seed state, persisted so re-running is idempotent.
 *
 * Anchoring DIDs and status-list indexes here means catalogs and hosted credentials stay valid
 * across restarts; `--reset` is what deliberately re-issues everything.
 */

import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

export interface SeedState {
  issuerDid?: string
  statusListId?: string
  /** did:hedera per resource key. */
  dids: Partial<Record<'acmeAgent' | 'acmeMcp' | 'pro', string>>
  /** Status list index per credential (resource keys plus the officer credential). */
  statusIndexes: Partial<Record<'acmeAgent' | 'acmeMcp' | 'pro' | 'officer', number>>
  officerOffer?: string
  seededAt?: string
}

const STATE_PATH = resolve(process.cwd(), '.seed-state.json')

export function loadState(): SeedState {
  if (!existsSync(STATE_PATH)) return { dids: {}, statusIndexes: {} }
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as Partial<SeedState>
    // Defaults after the spread, not before: a file missing `dids` would otherwise
    // spread `dids: undefined` over the default and every later lookup would throw.
    return { ...parsed, dids: parsed.dids ?? {}, statusIndexes: parsed.statusIndexes ?? {} }
  } catch {
    return { dids: {}, statusIndexes: {} }
  }
}

export function saveState(state: SeedState): void {
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`)
}

export function clearState(): void {
  if (existsSync(STATE_PATH)) rmSync(STATE_PATH)
}

export function statePath(): string {
  return STATE_PATH
}
