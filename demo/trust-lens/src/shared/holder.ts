/**
 * Ephemeral OID4VCI holder.
 *
 * Heka Identity Service issues credentials only through OID4VCI offers — there is no
 * "sign this credential and hand me the bytes" endpoint. Resource Passports, however, must be
 * published as static files at their attestation URIs. So the seed claims its own offers with
 * a throwaway holder and keeps the resulting compact SD-JWT (issuer-signed JWT + disclosures;
 * no key-binding JWT, which is only added when presenting).
 *
 * The holder binding key is incidental for a hosted attestation — what the verifier checks is
 * the credential's `resource_did` against the catalog's trustManifest identity.
 */

import { Agent, ConsoleLogger, DidKey, DidsModule, Kms, LogLevel } from '@credo-ts/core'
import { agentDependencies } from '@credo-ts/node'
import { AskarModule } from '@credo-ts/askar'
import { HederaDidResolver, HederaModule } from '@credo-ts/hedera'
import { OpenId4VcModule } from '@credo-ts/openid4vc'
import { askarNodeJS } from '@openwallet-foundation/askar-nodejs'

import { ephemeralSqliteStore } from './askar-store'

export type HolderAgent = Agent<{ openid4vc: OpenId4VcModule }>

/** Hedera network config shared by the holder and anything else resolving did:hedera. */
export function hederaNetworksFromEnv() {
  const network = process.env.HEDERA_NETWORK ?? 'testnet'
  const operatorId = process.env.HEDERA_OPERATOR_ID
  const operatorKey = process.env.HEDERA_OPERATOR_KEY
  if (!operatorId || !operatorKey) {
    throw new Error('HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY must be set (see .env.example)')
  }
  return [{ network, operatorId, operatorKey }] as never
}

export function createHolderAgent(label = 'trust-lens-seed-holder'): HolderAgent {
  return new Agent({
    config: {
      logger: new ConsoleLogger(process.env.CREDO_LOG_DEBUG === '1' ? LogLevel.Debug : LogLevel.Error),
      allowInsecureHttpUrls: true,
    },
    dependencies: agentDependencies,
    modules: {
      askar: new AskarModule({
        askar: askarNodeJS,
        store: ephemeralSqliteStore(label, 'trust-lens-seed'),
      }),
      openid4vc: new OpenId4VcModule(),
      // Credo verifies the issuer signature as part of claiming, so the holder must be able
      // to resolve the issuer's did:hedera.
      hedera: new HederaModule({ networks: hederaNetworksFromEnv() }),
      dids: new DidsModule({ resolvers: [new HederaDidResolver()] }),
    },
  }) as HolderAgent
}

/**
 * Claim a credential offer (pre-authorized code flow) and return the compact credential.
 * The offer URI must be reachable from this process — see infra/docker-compose.dev.yml for the
 * loopback bridge used when the Identity Service runs on the host.
 */
export async function claimCredentialOffer(agent: HolderAgent, credentialOffer: string): Promise<string> {
  const resolved = await agent.openid4vc.holder.resolveCredentialOffer(credentialOffer)
  const accessToken = await agent.openid4vc.holder.requestToken({ resolvedCredentialOffer: resolved })

  const { credentials } = await agent.openid4vc.holder.requestCredentials({
    resolvedCredentialOffer: resolved,
    ...accessToken,
    credentialConfigurationIds: resolved.credentialOfferPayload.credential_configuration_ids,
    verifyCredentialStatus: false,
    credentialBindingResolver: async ({ proofTypes }: { proofTypes: { jwt?: { supportedSignatureAlgorithms: string[] } } }) => {
      // A hosted attestation has no real holder; bind to a throwaway did:key so the
      // issuer's proof-of-possession requirement is satisfied.
      if (!proofTypes.jwt) throw new Error('issuer requires a proof type this holder does not support')

      const algorithm = proofTypes.jwt.supportedSignatureAlgorithms[0]
      const created = await agent.kms.createKeyForSignatureAlgorithm({ algorithm } as never)
      const publicJwk = Kms.PublicJwk.fromUnknown(created.publicJwk)

      const didResult = await agent.dids.create({ method: 'key', options: { keyId: publicJwk.keyId } } as never)
      if (didResult.didState.state !== 'finished') throw new Error('holder DID creation failed')

      const didKey = DidKey.fromDid(didResult.didState.did as string)
      return { method: 'did', didUrls: [`${didKey.did}#${didKey.publicJwk.fingerprint}`] }
    },
  } as never)

  const compact = extractCompactCredential(credentials)
  if (!compact) {
    throw new Error(`could not extract a compact credential from the issuer response`)
  }
  return compact
}

/**
 * Put a claimed credential into the holder's wallet.
 *
 * Claiming an offer returns the credential; it does not file it. Anything that later has to
 * *present* the credential (as opposed to just hosting its bytes) needs it stored, or credential
 * selection finds nothing.
 */
export async function storeCredential(agent: HolderAgent, compactSdJwtVc: string): Promise<void> {
  const { SdJwtVcRecord } = await import('@credo-ts/core')
  const record = new SdJwtVcRecord({ credentialInstances: [{ compactSdJwtVc }] } as never)
  await agent.sdJwtVc.store({ record } as never)
}

/** Credo's response shape varies by version/format; dig out the compact SD-JWT string. */
function extractCompactCredential(credentials: unknown): string | undefined {
  const visit = (node: unknown, depth = 0): string | undefined => {
    if (depth > 6 || node == null) return undefined
    if (typeof node === 'string') return node.includes('~') || node.split('.').length === 3 ? node : undefined
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = visit(item, depth + 1)
        if (found) return found
      }
      return undefined
    }
    if (typeof node === 'object') {
      const record = node as Record<string, unknown>
      for (const key of ['compact', 'compactSdJwtVc', 'credential', 'credentials']) {
        if (key in record) {
          const found = visit(record[key], depth + 1)
          if (found) return found
        }
      }
      for (const value of Object.values(record)) {
        const found = visit(value, depth + 1)
        if (found) return found
      }
    }
    return undefined
  }

  return visit(credentials)
}
