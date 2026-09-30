import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WalletLink, WalletLinkTransport } from '../wallet-link'

const HOLDER_DID = 'did:peer:2.Ez6LSwallet.Vz6MkWallet.SeyJ0IjoiZG0ifQ'

function fakeTransport(): WalletLinkTransport {
  return {
    initialize: vi.fn(async () => undefined),
    resolveServiceTypes: vi.fn(async () => ['did-communication']),
    connect: vi.fn(async () => 'connection-1'),
    send: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  }
}

// The Trust Lens and the TrustCo Console each hold a WalletLink on the same file; these are the two.
describe('WalletLink shared through the link file', () => {
  let dir: string
  let stateFile: string

  const make = () => new WalletLink({ stateFile, transport: fakeTransport, log: () => undefined })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wallet-link-'))
    stateFile = join(dir, '.wallet-link.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('sees a link made by the other process', async () => {
    const a = make()
    const b = make()

    await a.link(HOLDER_DID)

    expect(b.status).toMatchObject({ linked: true, holderDid: HOLDER_DID, source: 'file' })
  })

  it('forgets a link the other process removed, and refuses to deliver', async () => {
    const a = make()
    const b = make()
    await a.link(HOLDER_DID)
    expect(b.status.linked).toBe(true)

    await a.unlink()

    expect(b.status).toEqual({ linked: false })
    await expect(b.send('openid4vp://request')).rejects.toThrow(/no wallet linked/)
  })

  it('keeps a DID seeded from the env when there is no file', () => {
    const seeded = new WalletLink({ stateFile, initialDid: HOLDER_DID, transport: fakeTransport, log: () => undefined })

    expect(seeded.status).toMatchObject({ linked: true, holderDid: HOLDER_DID, source: 'env' })
  })
})
