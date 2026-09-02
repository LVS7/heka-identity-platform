/**
 * Phase 1 de-risking: can we capture the signed bytes of a credential Heka only offers
 * through OID4VCI? Resource Passports must be hosted as static files, so this must work.
 *
 * Run: yarn derisk:holder
 */

import * as dotenv from 'dotenv'

import { RESOURCE_PASSPORT_VCT } from '../core/types'
import { claimCredentialOffer, createHolderAgent } from '../shared/holder'
import { identityServiceFromEnv } from '../shared/identity-service'

dotenv.config()

async function main() {
  const identityService = identityServiceFromEnv()

  console.log('[1/4] creating did:hedera issuer...')
  const { id: issuerDid } = await identityService.createDid('hedera')
  console.log(`      ${issuerDid}`)

  console.log('[2/4] registering issuer + credential configuration...')
  await identityService.createIssuer(issuerDid, [
    { format: 'vc+sd-jwt', id: 'ResourcePassport', vct: RESOURCE_PASSPORT_VCT },
  ])

  console.log('[3/4] creating the offer...')
  const { credentialOffer } = await identityService.createIssuanceOffer(issuerDid, [
    {
      format: 'vc+sd-jwt',
      credentialSupportedId: 'ResourcePassport',
      issuer: { method: 'did', did: issuerDid },
      payload: {
        vct: RESOURCE_PASSPORT_VCT,
        resource_did: 'did:hedera:testnet:holder-derisk',
        resource_name: 'Holder De-risk Resource',
        resource_type: 'a2a-agent',
        operator: { legal_name: 'De-risk Corp', domain: 'example.invalid' },
      },
      disclosureFrame: { _sd: [] },
    },
  ])
  console.log(`      offer: ${credentialOffer.slice(0, 90)}...`)

  console.log('[4/4] claiming it with an ephemeral holder...')
  const agent = createHolderAgent()
  await agent.initialize()
  try {
    const compact = await claimCredentialOffer(agent, credentialOffer)
    const parts = compact.split('~')
    console.log(`      captured ${compact.length} chars, ${parts.length - 1} disclosure(s)`)
    console.log(`      starts: ${compact.slice(0, 60)}...`)
    console.log('\nRESULT: PASS — signed credential bytes captured and ready to host')
  } finally {
    await agent.shutdown()
  }
}

main().catch((error) => {
  console.error('[derisk:holder] FATAL', error?.response?.data ?? error?.message ?? error)
  process.exit(1)
})
