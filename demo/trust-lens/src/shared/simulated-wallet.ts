/**
 * A wallet-free way to run the authorization step.
 *
 * The demo's real story is a human presenting a credential from Heka Wallet on a phone. That
 * needs a device (or an emulator) and a person, which is fine for a live demo and awkward for
 * everything else — development, review, CI, a colleague who wants to see it in two minutes.
 *
 * So the demo also ships a simulated holder: the same Credo stack, the same OID4VP exchange,
 * the same credential — just driven in-process instead of by a thumb. It is clearly labelled
 * as simulated wherever it is offered, because who presented the credential is exactly the
 * thing this demo is about.
 *
 * What it does NOT do is bypass anything: the presentation is real, the verifier checks it
 * normally, and a revoked credential is refused here exactly as it would be from the phone.
 */

import * as dotenv from 'dotenv'

import { OFFICER_CREDENTIAL } from './demo-config'
import { claimCredentialOffer, createHolderAgent, HolderAgent, storeCredential } from './holder'
import { IdentityServiceClient } from './identity-service'
import { createOfficerOffer } from './officer-offer'
import { loadState, seedFingerprint } from '../seed/state'

dotenv.config()

export class SimulatedWallet {
  private agent: HolderAgent | undefined
  /** Memoized: two first presentations at once (A2A and MCP) wait for one start instead of racing two. */
  private ready: Promise<HolderAgent> | undefined
  /** The seed the held credential was minted from (`seedFingerprint`). */
  private mintedFor: string | undefined

  public constructor(private readonly identityService: IdentityServiceClient) {}

  /**
   * Bring up the holder and put a Finance Data Officer credential in it. A failed start is
   * forgotten, so the next presentation tries again rather than failing for good.
   */
  public initialize(): Promise<HolderAgent> {
    this.ready ??= this.start().catch(async (error: unknown) => {
      await this.shutdown()
      throw error
    })
    return this.ready
  }

  /**
   * A fresh offer is minted rather than reusing the one `yarn seed` printed: that one is for
   * the phone, and a pre-authorized code is single-use.
   */
  private async start(): Promise<HolderAgent> {
    const state = loadState()
    if (!state.issuerDid || state.statusIndexes.officer === undefined || !state.statusListId) {
      throw new Error('no seed state — run `yarn seed` first')
    }

    const agent = createHolderAgent('trust-lens-simulated-wallet')
    this.agent = agent
    await agent.initialize()

    const credentialOffer = await createOfficerOffer(this.identityService, state)
    const compact = await claimCredentialOffer(agent, credentialOffer)
    await storeCredential(agent, compact)
    this.mintedFor = seedFingerprint(state)
    console.log(`[wallet] simulated holder ready, holding a ${OFFICER_CREDENTIAL.role} credential`)
    return agent
  }

  /** Resolve an OID4VP request and present the officer credential against it. */
  public async present(authorizationRequest: string): Promise<void> {
    // After `yarn seed --reset` the held credential names an issuer nobody trusts any more.
    if (this.mintedFor && this.mintedFor !== seedFingerprint(loadState())) {
      console.log('[wallet] the seed changed since the credential was minted; minting a fresh one')
      await this.shutdown()
    }
    const agent = await this.initialize()

    const resolved = (await agent.openid4vc.holder.resolveOpenId4VpAuthorizationRequest(authorizationRequest)) as {
      presentationExchange?: { credentialsForRequest?: PexRequirements }
      authorizationRequestPayload: unknown
    }

    // The agent asks with Presentation Exchange; DCQL requests are out of scope here.
    const forRequest = resolved.presentationExchange?.credentialsForRequest
    if (!forRequest) {
      throw new Error('the verifier asked for something this simulated wallet cannot satisfy')
    }
    if (forRequest.areRequirementsSatisfied === false) {
      throw new Error('the simulated wallet holds no credential matching the request')
    }

    // Pick the first matching credential per input descriptor — the holder has exactly one.
    const credentials = Object.fromEntries(
      forRequest.requirements.flatMap((requirement) =>
        requirement.submissionEntry
          .slice(0, requirement.needsCount)
          .map((entry) => [entry.inputDescriptorId, [entry.verifiableCredentials[0]]])
      )
    )

    await agent.openid4vc.holder.acceptOpenId4VpAuthorizationRequest({
      authorizationRequestPayload: resolved.authorizationRequestPayload,
      presentationExchange: { credentials },
    } as never)

    console.log('[wallet] simulated presentation submitted')
  }

  public async shutdown(): Promise<void> {
    const agent = this.agent
    this.agent = undefined
    this.ready = undefined
    this.mintedFor = undefined
    await agent?.shutdown().catch(() => undefined)
  }
}

interface PexRequirements {
  areRequirementsSatisfied?: boolean
  requirements: Array<{
    needsCount: number
    submissionEntry: Array<{ inputDescriptorId: string; verifiableCredentials: unknown[] }>
  }>
}
