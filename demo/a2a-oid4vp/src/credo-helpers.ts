import { Agent as CredoAgent, ConsoleLogger, LogLevel, PeerDidNumAlgo } from '@credo-ts/core'
import { agentDependencies, DidCommHttpInboundTransport } from '@credo-ts/node'
import { DidCommHttpOutboundTransport, DidCommModule, DidCommWsOutboundTransport } from '@credo-ts/didcomm'
import { AskarModule } from '@credo-ts/askar'
import { askarNodeJS } from '@openwallet-foundation/askar-nodejs'

export type CredoAgentWithDidComm = CredoAgent<{ didcomm: DidCommModule }>

export function createCredoAgent(agentName: string, inboundPort: number = 3010): CredoAgentWithDidComm {
  const agentHttpEndpoint = `http://localhost:${inboundPort}`

  const agent = new CredoAgent({
    config: {
      logger: new ConsoleLogger(process.env.CREDO_LOG_DEBUG === '1' ? LogLevel.debug : LogLevel.info),
      allowInsecureHttpUrls: true,
    },
    dependencies: agentDependencies,
    modules: {
      askar: new AskarModule({
        askar: askarNodeJS,
        store: {
          id: agentName,
          key: 'key',
          database: {
            type: 'sqlite',
            config: {
              // In-memory SQLite is per-connection: with a pool >1, the connection that
              // provisions the schema differs from the one that reads it, causing
              // "no such table: profiles". Pin to a single shared connection.
              inMemory: true,
              maxConnections: 1,
              minConnections: 1,
            },
          },
        },
      }),
      didcomm: new DidCommModule({
        endpoints: [agentHttpEndpoint],
        connections: { peerNumAlgoForDidExchangeRequests: PeerDidNumAlgo.MultipleInceptionKeyWithoutDoc },
      }),
    },
  })

  agent.didcomm.registerInboundTransport(new DidCommHttpInboundTransport({ port: inboundPort }))
  agent.didcomm.registerOutboundTransport(new DidCommHttpOutboundTransport())
  agent.didcomm.registerOutboundTransport(new DidCommWsOutboundTransport())

  return agent
}
