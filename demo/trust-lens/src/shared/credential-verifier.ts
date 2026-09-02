/**
 * Credo-backed implementations of the verification engine's external capabilities:
 * resolving did:hedera and verifying SD-JWT VC signatures.
 *
 * Kept out of src/core so the decision logic stays dependency-light and unit-testable.
 */

import { Agent, ConsoleLogger, DidsModule, LogLevel } from '@credo-ts/core'
import { AskarModule } from '@credo-ts/askar'
import { HederaDidResolver, HederaModule } from '@credo-ts/hedera'
import { agentDependencies } from '@credo-ts/node'
import { askarNodeJS } from '@openwallet-foundation/askar-nodejs'

import { SdJwtVerification, VerifierDependencies } from '../core/verify'
import { ephemeralSqliteStore } from './askar-store'
import { hederaNetworksFromEnv } from './holder'

export type VerifierAgent = Agent<{ askar: AskarModule; hedera: HederaModule; dids: DidsModule }>

export function createVerifierAgent(label = 'trust-lens-verifier'): VerifierAgent {
  return new Agent({
    config: {
      logger: new ConsoleLogger(process.env.CREDO_LOG_DEBUG === '1' ? LogLevel.Debug : LogLevel.Error),
      allowInsecureHttpUrls: true,
    },
    dependencies: agentDependencies,
    modules: {
      askar: new AskarModule({
        askar: askarNodeJS,
        store: ephemeralSqliteStore(label, 'trust-lens-verifier'),
      }),
      hedera: new HederaModule({ networks: hederaNetworksFromEnv() }),
      dids: new DidsModule({ resolvers: [new HederaDidResolver()] }),
    },
  })
}

/**
 * Adapt a running agent into the dependencies the engine expects.
 * DID documents are cached per process — resolution hits the ledger and entries are re-verified
 * often, but revocation is never cached (it is live state, checked on every verdict).
 */
export function verifierDependencies(agent: VerifierAgent): VerifierDependencies {
  const didCache = new Map<string, { id: string }>()

  return {
    async resolveDid(did: string) {
      const cached = didCache.get(did)
      if (cached) return cached

      const result = await agent.dids.resolve(did)
      if (!result.didDocument) {
        throw new Error(result.didResolutionMetadata?.error ?? 'no DID document returned')
      }

      const resolved = { id: result.didDocument.id }
      didCache.set(did, resolved)
      return resolved
    },

    async verifySdJwt(compact: string): Promise<SdJwtVerification> {
      try {
        const result = await agent.sdJwtVc.verify({ compactSdJwtVc: compact })

        if (!result.isValid) {
          return { valid: false, error: describeVerificationError(result) }
        }

        const payload = (result.sdJwtVc?.prettyClaims ?? result.sdJwtVc?.payload) as SdJwtVerification['payload']
        return { valid: true, issuer: payload?.iss, payload }
      } catch (error) {
        return { valid: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

function describeVerificationError(result: unknown): string {
  const error = (result as { error?: { message?: string } })?.error
  return error?.message ?? 'SD-JWT verification failed'
}
