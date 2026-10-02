/**
 * TrustCo Console — the issuer's side of the demo.
 *
 * Deliberately minimal: three credential tiles and a revoke switch each. It exists because the
 * Heka Web UI does not expose credential lifecycle actions, and because the demo needs the
 * revocations to be performed by the *issuer*, visibly, rather than by a script nobody saw.
 *
 * Everything here goes through the Identity Service's status-list API. Status is read live from
 * the published status list — the same document any relying party reads — and the console keeps
 * only an in-memory journal of what it did (revocations, restores, offers). The seed state is read
 * per request and never written here, so `yarn seed --reset` needs no restart of the console.
 *
 * It also does the one issuer-side act the scenario needs before it starts: handing the operator
 * their Finance Data Officer credential. The offer is pushed to the wallet over DIDComm (see
 * `src/shared/wallet-link.ts`), so an emulator without a camera can receive it.
 */

import { resolve } from 'node:path'

import * as dotenv from 'dotenv'
import express from 'express'

import { AuditLog } from '../core/audit'
import { isRevokedInStatusList } from '../core/status-list'
import { loadState, SeedState } from '../seed/state'
import { DEMO_RESOURCES, OFFICER_CREDENTIAL, TRUSTCO } from '../shared/demo-config'
import { identityServiceFromEnv, IdentityServiceClient } from '../shared/identity-service'
import { listenOrExit } from '../shared/listen'
import { createOfficerOffer } from '../shared/officer-offer'
import { WALLET_LINK_FILE, WalletLink } from '../shared/wallet-link'
import { credoWalletTransport } from '../shared/wallet-link-credo'

dotenv.config()

const PORT = Number(process.env.TRUSTCO_CONSOLE_PORT ?? 4100)

type CredentialKey = 'officer' | 'acmeAgent' | 'acmeMcp' | 'pro'

interface CredentialTile {
  key: CredentialKey
  title: string
  subtitle: string
  statusListIndex: number
  revoked: boolean
  /** What revoking this one demonstrates, shown in the UI. */
  effect: string
}

function describe(state: SeedState): Array<Omit<CredentialTile, 'revoked'>> {
  const resource = (key: 'acmeAgent' | 'acmeMcp' | 'pro') => DEMO_RESOURCES.find((r) => r.key === key)

  return [
    {
      key: 'officer',
      title: OFFICER_CREDENTIAL.role,
      subtitle: `Role credential held by the operator · ${OFFICER_CREDENTIAL.org}`,
      statusListIndex: state.statusIndexes.officer as number,
      effect: 'Revoking denies the agent’s sensitive step — one revocation, every protocol path.',
    },
    {
      key: 'acmeAgent',
      title: `Resource Passport — ${resource('acmeAgent')?.displayName}`,
      subtitle: 'Attests the A2A agent to its operator',
      statusListIndex: state.statusIndexes.acmeAgent as number,
      effect: 'Revoking makes the agent unusable while the MCP server stays trusted.',
    },
    {
      key: 'acmeMcp',
      title: `Resource Passport — ${resource('acmeMcp')?.displayName}`,
      subtitle: 'Attests the MCP server to its operator',
      statusListIndex: state.statusIndexes.acmeMcp as number,
      effect: 'Revoking cuts off one resource without touching the agent — per-resource granularity.',
    },
  ]
}

async function readTiles(identityService: IdentityServiceClient, state: SeedState): Promise<CredentialTile[]> {
  const statusList = await identityService.fetchStatusList(state.statusListId as string)

  return describe(state).map((tile) => ({
    ...tile,
    revoked: isRevokedInStatusList(statusList, tile.statusListIndex),
  }))
}

function main() {
  const initial = loadState()
  if (!initial.statusListId) throw new Error('no seed state — run `yarn seed` first')

  const identityService = identityServiceFromEnv()
  // The issuer's own journal. Revocations and offers are issuer acts, and an audience should be
  // able to read them where they happened rather than infer them from a relying party's log.
  const audit = new AuditLog()

  // Same link file as the Trust Lens: the operator pastes their wallet DID once, on either UI.
  const walletLink = new WalletLink({
    stateFile: WALLET_LINK_FILE,
    initialDid: process.env.HOLDER_PUBLIC_DID,
    transport: () => credoWalletTransport({ label: 'trustco-console-wallet-link' }),
  })

  const app = express()
  app.use(express.json())
  app.use(express.static(resolve(process.cwd(), 'src/console/public')))
  // The console reuses the Trust Lens stylesheet; a relative `../../` link cannot escape a static root.
  app.use('/shared', express.static(resolve(process.cwd(), 'src/web/public')))

  app.get('/api/credentials', async (_req, res) => {
    const state = loadState()
    try {
      res.json({
        issuer: { name: TRUSTCO.name, legalName: TRUSTCO.legalName, did: state.issuerDid },
        statusList: identityService.statusListUrl(state.statusListId as string),
        credentials: await readTiles(identityService, state),
      })
    } catch (error) {
      res.status(502).json({ error: (error as Error).message })
    }
  })

  app.get('/api/wallet', (_req, res) => {
    res.json(walletLink.status)
  })

  app.post('/api/wallet/link', async (req, res) => {
    try {
      res.json(await walletLink.link(String(req.body?.holderDid ?? '').trim()))
    } catch (error) {
      res.status(400).json({ error: (error as Error).message })
    }
  })

  app.delete('/api/wallet/link', async (_req, res) => {
    try {
      await walletLink.unlink()
      res.json(walletLink.status)
    } catch (error) {
      // The link file could not be removed (EBUSY on Windows, say): say so rather than claim "not linked".
      res.status(500).json({ error: (error as Error).message })
    }
  })

  /**
   * Issue the officer credential to the operator's wallet: mint a fresh offer (pre-authorized
   * codes are single-use) and push it over DIDComm. The offer is returned too, for a phone with a
   * camera or a wallet that is not linked.
   */
  app.post('/api/credentials/officer/offer', async (_req, res) => {
    try {
      // From the state as it is now: an offer minted from a pre-reseed issuer would be refused by both paths.
      const offer = await createOfficerOffer(identityService, loadState())

      if (!walletLink.status.linked) {
        audit.record('issuance', OFFICER_CREDENTIAL.role, 'offer minted', { handedOver: false, via: 'offer URI' })
        res.json({ offer, delivered: false, note: 'no wallet linked — scan or deep-link the offer instead' })
        return
      }

      try {
        await walletLink.send(offer)
        // Handed over, not delivered: Credo's HTTP sender does not check the mediator's answer.
        console.log('[console] officer credential offer handed to the wallet’s mediator')
        audit.record('issuance', OFFICER_CREDENTIAL.role, 'offer minted', {
          handedOver: true,
          via: 'DIDComm basic message, to the wallet’s mediator',
        })
        res.json({ offer, delivered: true })
      } catch (error) {
        const message = (error as Error).message
        // The offer exists either way; the journal should say it was minted and why it did not arrive.
        audit.record('issuance', OFFICER_CREDENTIAL.role, 'offer minted', {
          handedOver: false,
          via: 'DIDComm basic message',
          error: message,
        })
        res.status(502).json({ offer, delivered: false, error: message })
      }
    } catch (error) {
      res.status(502).json({ error: (error as Error).message })
    }
  })

  app.post('/api/credentials/:key/status', async (req, res) => {
    const state = loadState()
    const key = req.params.key as CredentialKey
    // Own keys only: "constructor" and friends resolve through the prototype and would reach Heka.
    const index = Object.hasOwn(state.statusIndexes, key) ? state.statusIndexes[key] : undefined
    // Strict: Boolean("false") is true, and a revoke is not something to infer from a string.
    const revoked = req.body?.revoked === true

    if (index === undefined) {
      res.status(404).json({ error: `unknown credential "${key}"` })
      return
    }

    try {
      await identityService.setRevoked(state.statusListId as string, [index], revoked)
      console.log(`[console] ${key} (index ${index}) -> ${revoked ? 'REVOKED' : 'active'}`)
      const title = describe(state).find((tile) => tile.key === key)?.title ?? key
      audit.record('revocation', title, revoked ? 'REVOKED' : 'RESTORED', {
        key,
        statusListIndex: index,
        statusList: identityService.statusListUrl(state.statusListId as string),
      })
      res.json({ ok: true, credentials: await readTiles(identityService, state) })
    } catch (error) {
      res.status(502).json({ error: (error as Error).message })
    }
  })

  app.get('/api/audit', (req, res) => {
    const type = req.query.type ? String(req.query.type) : undefined
    res.json({ events: audit.list({ type: type as never }) })
  })

  listenOrExit(app, PORT, 'console', () => {
    console.log(`[console] TrustCo Console on http://localhost:${PORT}`)
    console.log(`[console] issuer: ${initial.issuerDid}`)
  })
}

try {
  main()
} catch (error) {
  console.error('[console] FATAL', (error as Error)?.message ?? error)
  process.exit(1)
}
