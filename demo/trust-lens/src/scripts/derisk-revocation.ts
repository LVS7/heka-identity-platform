/**
 * Phase 0.2 de-risking script — proves the whole credential lifecycle the demo depends on:
 *
 *   1. create a did:hedera identity (anchored on Hedera testnet)
 *   2. register it as an OID4VC issuer with the Resource Passport credential config
 *   3. create a Bitstring Status List owned by that issuer
 *   4. create an issuance offer whose payload carries our app-layer `credentialStatus` claim (D7)
 *   5. read the status list publicly and confirm the credential reads as NOT revoked
 *   6. revoke that index and confirm the public status list now reads as REVOKED
 *
 * Run: yarn derisk
 */

import * as dotenv from 'dotenv'

import { isRevokedInStatusList } from '../core/status-list'
import { RESOURCE_PASSPORT_VCT } from '../core/types'
import { identityServiceFromEnv } from '../shared/identity-service'

dotenv.config()

const STATUS_INDEX = 5

async function main() {
  const identityService = identityServiceFromEnv()

  console.log('[1/6] creating did:hedera (anchors a topic on Hedera testnet, takes a few seconds)...')
  const didDocument = await identityService.createDid('hedera')
  const issuerDid = didDocument.id
  console.log(`      issuer DID: ${issuerDid}`)

  console.log('[2/6] registering the OID4VC issuer...')
  const issuer = await identityService.createIssuer(issuerDid, [
    { format: 'vc+sd-jwt', id: 'ResourcePassport', vct: RESOURCE_PASSPORT_VCT },
  ])
  console.log(`      issuer record: ${issuer.id}`)

  console.log('[3/6] creating the status list...')
  const statusListId = await identityService.createStatusList(issuerDid)
  const statusListCredentialUrl = identityService.statusListUrl(statusListId)
  console.log(`      status list: ${statusListCredentialUrl}`)

  console.log('[4/6] creating an issuance offer carrying the credentialStatus claim...')
  const offer = await identityService.createIssuanceOffer(issuerDid, [
    {
      format: 'vc+sd-jwt',
      credentialSupportedId: 'ResourcePassport',
      issuer: { method: 'did', did: issuerDid },
      payload: {
        vct: RESOURCE_PASSPORT_VCT,
        resource_did: 'did:hedera:testnet:derisk-example-agent',
        resource_name: 'De-risk Example Agent',
        resource_type: 'a2a-agent',
        resource_card_url: 'https://example.invalid/.well-known/agent-card.json',
        resource_card_digest: 'sha256-derisk',
        operator: { legal_name: 'De-risk Corp', domain: 'example.invalid' },
        credentialStatus: { statusListCredential: statusListCredentialUrl, statusListIndex: STATUS_INDEX },
      },
      disclosureFrame: { _sd: [] },
    },
  ])
  console.log(`      offer created (state=${offer.issuanceSession.state})`)

  console.log('[5/6] reading the public status list before revocation...')
  const before = await identityService.fetchStatusList(statusListId)
  const revokedBefore = isRevokedInStatusList(before, STATUS_INDEX)
  console.log(`      revoked=${revokedBefore} (expected false)`)

  console.log(`[6/6] revoking index ${STATUS_INDEX} and re-reading...`)
  await identityService.setRevoked(statusListId, [STATUS_INDEX], true)
  const after = await identityService.fetchStatusList(statusListId)
  const revokedAfter = isRevokedInStatusList(after, STATUS_INDEX)
  const neighbourUntouched = !isRevokedInStatusList(after, STATUS_INDEX + 1)
  console.log(`      revoked=${revokedAfter} (expected true), neighbour untouched=${neighbourUntouched}`)

  const ok = !revokedBefore && revokedAfter && neighbourUntouched
  console.log(ok ? '\nRESULT: PASS — issue -> status-bound -> revoke -> observe works end to end' : '\nRESULT: FAIL')
  if (!ok) process.exit(1)
}

main().catch((error) => {
  console.error('[derisk] FATAL', error?.response?.data ?? error?.message ?? error)
  process.exit(1)
})
