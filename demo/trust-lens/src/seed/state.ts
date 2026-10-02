/**
 * Seed state, persisted so re-running is idempotent.
 *
 * Anchoring DIDs and status-list indexes here means catalogs and hosted credentials stay valid
 * across restarts; `--reset` is what deliberately re-issues everything.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

/** Resolved per call, from the directory the process (or a test) runs in. */
export function statePath(): string {
  return resolve(process.cwd(), '.seed-state.json')
}

export function loadState(): SeedState {
  const file = statePath()
  if (!existsSync(file)) return { dids: {}, statusIndexes: {} }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SeedState>
    // Defaults after the spread, not before: a file missing `dids` would otherwise
    // spread `dids: undefined` over the default and every later lookup would throw.
    return { ...parsed, dids: parsed.dids ?? {}, statusIndexes: parsed.statusIndexes ?? {} }
  } catch {
    return { dids: {}, statusIndexes: {} }
  }
}

/**
 * Written to a temp file and renamed: the agent and the AS read this file on every decision, and a
 * half-written file parses as "no issuer", which would turn a seed run into spurious denials.
 */
export function saveState(state: SeedState): void {
  const file = statePath()
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(temp, file)
}

/** What a credential minted from this state depends on; a change means its issuer world is gone. */
export function seedFingerprint(state: SeedState): string {
  return [state.issuerDid, state.statusListId, state.statusIndexes.officer].join('|')
}

export function clearState(): void {
  const file = statePath()
  if (existsSync(file)) rmSync(file)
}
