/**
 * TrustCo Console — the issuer's side of the demo.
 *
 * Deliberately minimal: three credential tiles and a revoke switch each. It exists because the
 * Heka Web UI does not expose credential lifecycle actions, and because the demo needs the
 * revocations to be performed by the *issuer*, visibly, rather than by a script nobody saw.
 *
 * Everything here goes through the Identity Service's status-list API. The console holds no
 * state of its own — status is read live from the published status list, which is the same
 * document any relying party reads.
 *
 * It also does the one issuer-side act the scenario needs before it starts: handing the operator
 * their Finance Data Officer credential. The offer is pushed to the wallet over DIDComm (see
 * `src/shared/wallet-link.ts`), so an emulator without a camera can receive it.
 */

import { resolve } from 'node:path'

import * as dotenv from 'dotenv'
import express from 'express'

import { isRevokedInStatusList } from '../core/status-list'
import { loadState, saveState, SeedState } from '../seed/state'
import { DEMO_RESOURCES, OFFICER_CREDENTIAL, TRUSTCO } from '../shared/demo-config'
import { identityServiceFromEnv, IdentityServiceClient } from '../shared/identity-service'
import { createOfficerOffer } from '../shared/officer-offer'
import { WALLET_LINK_FILE, WalletLink } from '../shared/wallet-link'
import { credoWalletTransport } from '../shared/wallet-link-credo'

dotenv.config()

const PORT = Number(process.env.TRUSTCO_CONSOLE_PORT ?? 4100)
const DIDCOMM_PORT = Number(process.env.TRUSTCO_CONSOLE_DIDCOMM_PORT ?? 4110)

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
  const state = loadState()
  if (!state.statusListId) throw new Error('no seed state — run `yarn seed` first')

  const identityService = identityServiceFromEnv()
  // Same link file as the Trust Lens: the operator pastes their wallet DID once, on either UI.
  const walletLink = new WalletLink({
    stateFile: WALLET_LINK_FILE,
    initialDid: process.env.HOLDER_PUBLIC_DID,
    transport: () => credoWalletTransport({ label: 'trustco-console-wallet-link', inboundPort: DIDCOMM_PORT }),
  })

  const app = express()
  app.use(express.json())
  app.use(express.static(resolve(process.cwd(), 'src/console/public')))
  // The console reuses the Trust Lens stylesheet; a relative `../../` link cannot escape a static root.
  app.use('/shared', express.static(resolve(process.cwd(), 'src/web/public')))

  app.get('/api/credentials', async (_req, res) => {
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

  /**
   * Issue the officer credential to the operator's wallet: mint a fresh offer (pre-authorized
   * codes are single-use) and push it over DIDComm. The offer is returned too, for a phone with a
   * camera or a wallet that is not linked.
   */
  app.post('/api/credentials/officer/offer', async (_req, res) => {
    try {
      const offer = await createOfficerOffer(identityService, state)
      state.officerOffer = offer
      saveState(state)

      if (!walletLink.status.linked) {
        res.json({ offer, delivered: false, note: 'no wallet linked — scan or deep-link the offer instead' })
        return
      }

      try {
        await walletLink.send(offer)
        console.log('[console] officer credential offer delivered to the operator’s wallet')
        res.json({ offer, delivered: true })
      } catch (error) {
        res.status(502).json({ offer, delivered: false, error: (error as Error).message })
      }
    } catch (error) {
      res.status(502).json({ error: (error as Error).message })
    }
  })

  app.post('/api/credentials/:key/status', async (req, res) => {
    const key = req.params.key as CredentialKey
    const index = state.statusIndexes[key]
    const revoked = Boolean(req.body?.revoked)

    if (index === undefined) {
      res.status(404).json({ error: `unknown credential "${key}"` })
      return
    }

    try {
      await identityService.setRevoked(state.statusListId as string, [index], revoked)
      console.log(`[console] ${key} (index ${index}) -> ${revoked ? 'REVOKED' : 'active'}`)
      res.json({ ok: true, credentials: await readTiles(identityService, state) })
    } catch (error) {
      res.status(502).json({ error: (error as Error).message })
    }
  })

  app.listen(PORT, () => {
    console.log(`[console] TrustCo Console on http://localhost:${PORT}`)
    console.log(`[console] issuer: ${state.issuerDid}`)
  })
}

try {
  main()
} catch (error) {
  console.error('[console] FATAL', (error as Error)?.message ?? error)
  process.exit(1)
}
