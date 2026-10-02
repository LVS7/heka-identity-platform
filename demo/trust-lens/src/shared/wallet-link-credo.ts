/**
 * The Credo side of `WalletLink`: a minimal DIDComm agent that can address the wallet's
 * `did:peer:2` and send it a basic message. Mirrors `demo/a2a-oid4vp/src/credo-helpers.ts` and
 * the connection forging in its `cli.ts`, with three differences: the Askar store is a temp file
 * (see `askar-store.ts` for why `inMemory` is a trap), the created-DID result is narrowed on
 * `state === 'finished'`, which this repo's strict typecheck requires, and nothing listens.
 *
 * Send-only on purpose. The wallet never answers us (it posts presentations to Heka), and the sender
 * is a `did:key` with no endpoint, so Credo marks each message `return_route: all` by itself. An
 * inbound transport would only add a port that is bound on first use — Credo's listener has no
 * error handler, so a port already taken would take the process down mid-demo.
 */

import { Agent, ConsoleLogger, KeyDidCreateOptions, LogLevel } from '@credo-ts/core'
import { agentDependencies } from '@credo-ts/node'
import {
  DidCommConnectionRecord,
  DidCommConnectionRepository,
  DidCommDidExchangeRole,
  DidCommDidExchangeState,
  DidCommHttpOutboundTransport,
  DidCommModule,
  DidCommWsOutboundTransport,
} from '@credo-ts/didcomm'
import { AskarModule } from '@credo-ts/askar'
import { askarNodeJS } from '@openwallet-foundation/askar-nodejs'

import { ephemeralSqliteStore } from './askar-store'
import { WalletLinkTransport } from './wallet-link'

type DidCommAgent = Agent<{ didcomm: DidCommModule; askar: AskarModule }>

export function credoWalletTransport(options: { label: string }): WalletLinkTransport {
  let agent: DidCommAgent | undefined

  const ready = (): DidCommAgent => {
    if (!agent) throw new Error('wallet transport not initialised')
    return agent
  }

  return {
    async initialize() {
      if (agent) return
      agent = new Agent({
        config: {
          logger: new ConsoleLogger(process.env.CREDO_LOG_DEBUG === '1' ? LogLevel.Debug : LogLevel.Error),
          // The reference demo's mediator endpoints are https/wss; plain http is only relevant
          // if someone points a wallet at a local mediator.
          allowInsecureHttpUrls: true,
        },
        dependencies: agentDependencies,
        modules: {
          askar: new AskarModule({
            askar: askarNodeJS,
            store: ephemeralSqliteStore(options.label, 'trust-lens-wallet-link'),
          }),
          // No DidsModule override: the default resolvers include did:peer, which is what the
          // wallet's public DID is. Passing an explicit `resolvers` list would replace them.
          didcomm: new DidCommModule({}),
        },
      }) as DidCommAgent

      agent.didcomm.registerOutboundTransport(new DidCommHttpOutboundTransport())
      agent.didcomm.registerOutboundTransport(new DidCommWsOutboundTransport())
      await agent.initialize()
    },

    async resolveServiceTypes(did) {
      const document = await ready().dids.resolveDidDocument(did)
      return (document.service ?? []).map((service) => String(service.type))
    },

    async connect(theirDid) {
      const current = ready()

      // Our side of the forged connection: a fresh did:key whose private key lives in this agent,
      // so the message sender can sign/encrypt with it. It advertises no endpoint on purpose.
      const { didState } = await current.dids.create<KeyDidCreateOptions>({
        method: 'key',
        options: { createKey: { type: { kty: 'OKP', crv: 'Ed25519' } } },
      })
      if (didState.state !== 'finished') {
        throw new Error(
          `could not create the sender DID (${didState.state === 'failed' ? didState.reason : didState.state})`
        )
      }

      const record = new DidCommConnectionRecord({
        role: DidCommDidExchangeRole.Requester,
        state: DidCommDidExchangeState.Completed,
        theirDid,
        did: didState.did,
      })
      await current.dependencyManager.resolve(DidCommConnectionRepository).save(current.context, record)
      return record.id
    },

    async send(connectionId, content) {
      await ready().didcomm.basicMessages.sendMessage(connectionId, content)
    },

    async shutdown() {
      await agent?.shutdown()
      agent = undefined
    },
  }
}
