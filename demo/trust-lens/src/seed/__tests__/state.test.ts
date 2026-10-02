import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadState, saveState, seedFingerprint } from '../state'

describe('seed state', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'seed-state-'))
    // The state path is resolved from the working directory on every call.
    vi.spyOn(process, 'cwd').mockReturnValue(cwd)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes atomically: the state reads back and no temp file is left behind', () => {
    saveState({ issuerDid: 'did:x', dids: {}, statusIndexes: { officer: 3 } })

    expect(loadState().issuerDid).toBe('did:x')
    expect(existsSync(join(cwd, '.seed-state.json.tmp'))).toBe(false)
  })

  it('fingerprints what a minted credential depends on', () => {
    const base = { issuerDid: 'did:a', statusListId: 'list-1', dids: {}, statusIndexes: { officer: 3 } }

    expect(seedFingerprint(base)).toBe(seedFingerprint({ ...base, dids: { pro: 'did:p' } }))
    expect(seedFingerprint(base)).not.toBe(seedFingerprint({ ...base, issuerDid: 'did:b' }))
    expect(seedFingerprint(base)).not.toBe(seedFingerprint({ ...base, statusListId: 'list-2' }))
  })
})
