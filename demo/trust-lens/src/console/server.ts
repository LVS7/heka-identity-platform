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
 */

import { resolve } from 'node:path'

import * as dotenv from 'dotenv'
import express from 'express'

import { isRevokedInStatusList } from '../core/status-list'
import { loadState, SeedState } from '../seed/state'
import { DEMO_RESOURCES, OFFICER_CREDENTIAL, TRUSTCO } from '../shared/demo-config'
import { identityServiceFromEnv, IdentityServiceClient } from '../shared/identity-service'

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
  const state = loadState()
  if (!state.statusListId) throw new Error('no seed state — run `yarn seed` first')

  const identityService = identityServiceFromEnv()

  const app = express()
  app.use(express.json())
  app.use(express.static(resolve(process.cwd(), 'src/console/public')))

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
