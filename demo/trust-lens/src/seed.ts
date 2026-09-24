/**
 * Idempotent demo seed.
 *
 * Produces everything the demo needs before anything is served:
 *  - a did:hedera per party (TrustCo issuer + the three published resources)
 *  - a TrustCo OID4VC issuer offering Resource Passport and Finance Data Officer credentials
 *  - a status list, one index per credential, so anything can be revoked independently
 *  - resource cards, then Resource Passports pinning those cards, then catalogs pinning
 *    those passports — each layer digest-bound to the one below
 *  - a credential offer for the operator's Finance Data Officer credential (scan with Heka Wallet)
 *
 * Pro's passport is deliberately issued for Acme's agent DID: a genuine, unexpired,
 * correctly-signed TrustCo credential that simply belongs to someone else. Only the subject
 * binding check catches it.
 *
 * Usage: yarn seed [--check | --reset]
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import * as dotenv from 'dotenv'

import { sha256Digest } from './core/digest'
import { RESOURCE_PASSPORT_VCT, ROLE_CREDENTIAL_VCT } from './core/types'
import { buildCard, buildCatalog, buildCatalogEntry } from './seed/cards'
import { clearState, loadState, saveState, statePath, SeedState } from './seed/state'
import {
  ACME_DOMAIN,
  DEMO_RESOURCES,
  DemoResource,
  OFFICER_CREDENTIAL,
  PRO_DOMAIN,
  TRUSTCO,
  catalogUrl,
  cardUrl,
} from './shared/demo-config'
import { claimCredentialOffer, createHolderAgent, HolderAgent } from './shared/holder'
import { IdentityServiceClient, identityServiceFromEnv } from './shared/identity-service'
import { createOfficerOffer } from './shared/officer-offer'

dotenv.config()

const STATIC_ROOT = resolve(process.cwd(), 'static')
const AGENT_URL = process.env.ACME_AGENT_URL ?? `http://localhost:${process.env.ACME_AGENT_PORT ?? 10003}/`

const STATUS_INDEXES = { acmeAgent: 0, acmeMcp: 1, pro: 2, officer: 3 } as const

function writeStatic(site: string, relativePath: string, content: string): string {
  const target = resolve(STATIC_ROOT, site, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  return target
}

async function ensureDids(identityService: IdentityServiceClient, state: SeedState) {
  if (!state.issuerDid) {
    console.log('  creating TrustCo issuer DID on Hedera...')
    state.issuerDid = (await identityService.createDid('hedera')).id
    saveState(state)
  }
  console.log(`  TrustCo: ${state.issuerDid}`)

  for (const resource of DEMO_RESOURCES) {
    if (!state.dids[resource.key]) {
      console.log(`  creating DID for ${resource.displayName}...`)
      state.dids[resource.key] = (await identityService.createDid('hedera')).id
      saveState(state)
    }
    console.log(`  ${resource.displayName}: ${state.dids[resource.key]}`)
  }
}

async function ensureIssuerAndStatusList(identityService: IdentityServiceClient, state: SeedState) {
  const issuerDid = state.issuerDid as string

  try {
    await identityService.createIssuer(issuerDid, [
      { format: 'vc+sd-jwt', id: 'ResourcePassport', vct: RESOURCE_PASSPORT_VCT },
      { format: 'vc+sd-jwt', id: OFFICER_CREDENTIAL.configurationId, vct: ROLE_CREDENTIAL_VCT },
    ])
    console.log('  issuer registered with both credential configurations')
  } catch (error: unknown) {
    // Re-running the seed against an existing issuer is expected.
    const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? ''
    console.log(`  issuer already registered${message ? ` (${message})` : ''}`)
  }

  if (!state.statusListId) {
    state.statusListId = await identityService.createStatusList(issuerDid)
    state.statusIndexes = { ...STATUS_INDEXES }
    saveState(state)
  }
  console.log(`  status list: ${identityService.statusListUrl(state.statusListId)}`)
}

/**
 * Issue a Resource Passport and return its compact SD-JWT.
 *
 * `subjectDid` is passed separately from the resource on purpose — for Pro it is Acme's agent
 * DID, which is what makes the replayed credential detectable.
 */
async function issueResourcePassport(
  identityService: IdentityServiceClient,
  holder: HolderAgent,
  state: SeedState,
  resource: DemoResource,
  subjectDid: string,
  cardDigest: string
): Promise<string> {
  const issuerDid = state.issuerDid as string
  const statusListId = state.statusListId as string
  const statusListIndex = state.statusIndexes[resource.key] as number

  const { credentialOffer } = await identityService.createIssuanceOffer(issuerDid, [
    {
      format: 'vc+sd-jwt',
      credentialSupportedId: 'ResourcePassport',
      issuer: { method: 'did', did: issuerDid },
      payload: {
        vct: RESOURCE_PASSPORT_VCT,
        resource_did: subjectDid,
        resource_name: resource.displayName,
        resource_type: resource.resourceType,
        resource_card_url: cardUrl(resource),
        resource_card_digest: cardDigest,
        operator: {
          legal_name: resource.operator.legalName,
          domain: resource.operator.domain,
          kyb_ref: resource.operator.kybRef,
        },
        capabilities: resource.capabilities,
        credentialStatus: {
          statusListCredential: identityService.statusListUrl(statusListId),
          statusListIndex,
        },
      },
      // Resource passports are public attestations — nothing is selectively disclosed.
      disclosureFrame: { _sd: [] },
    },
  ])

  return claimCredentialOffer(holder, credentialOffer)
}

async function seed() {
  const identityService = identityServiceFromEnv()
  const state = loadState()

  console.log('\n== identities ==')
  await ensureDids(identityService, state)

  console.log('\n== issuer and revocation ==')
  await ensureIssuerAndStatusList(identityService, state)

  console.log('\n== resource cards ==')
  const cardDigests = new Map<string, string>()
  for (const resource of DEMO_RESOURCES) {
    const card = `${JSON.stringify(buildCard(resource, AGENT_URL), null, 2)}\n`
    writeStatic(resource.site, `.well-known/${resource.cardFile}`, card)
    cardDigests.set(resource.key, sha256Digest(card))
    console.log(`  ${resource.site}/${resource.cardFile} (${cardDigests.get(resource.key)})`)
  }

  console.log('\n== resource passports ==')
  const holder = createHolderAgent()
  await holder.initialize()

  const attestationDigests = new Map<string, string>()
  try {
    for (const resource of DEMO_RESOURCES) {
      // The lookalike gets a real credential issued for Acme's agent — a replay.
      const subjectDid =
        resource.key === 'pro' ? (state.dids.acmeAgent as string) : (state.dids[resource.key] as string)

      const compact = await issueResourcePassport(
        identityService,
        holder,
        state,
        resource,
        subjectDid,
        cardDigests.get(resource.key) as string
      )

      writeStatic(resource.site, `.well-known/attestations/${resource.attestationFile}`, compact)
      attestationDigests.set(resource.key, sha256Digest(compact))

      const note = resource.key === 'pro' ? '  <- subject is Acme’s agent (replay)' : ''
      console.log(`  ${resource.site}/${resource.attestationFile} subject=${subjectDid.slice(0, 42)}...${note}`)
    }
  } finally {
    await holder.shutdown()
  }

  console.log('\n== catalogs ==')
  for (const [site, domain] of [
    ['acme-site', ACME_DOMAIN],
    ['pro-site', PRO_DOMAIN],
  ] as const) {
    const entries = DEMO_RESOURCES.filter((resource) => resource.site === site).map((resource) =>
      buildCatalogEntry(resource, state.dids[resource.key] as string, attestationDigests.get(resource.key) as string)
    )
    writeStatic(site, '.well-known/ai-catalog.json', `${JSON.stringify(buildCatalog(domain, entries), null, 2)}\n`)
    console.log(`  ${catalogUrl(domain)} (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`)
  }

  console.log('\n== operator credential ==')
  state.officerOffer = await createOfficerOffer(identityService, state)
  state.seededAt = new Date().toISOString()
  saveState(state)
  console.log(`  scan with Heka Wallet to receive the ${OFFICER_CREDENTIAL.role} credential:`)
  console.log(`  ${state.officerOffer}`)

  console.log(`\nseed complete — state in ${statePath()}`)
}

function check() {
  const state = loadState()
  const missing: string[] = []
  if (!state.issuerDid) missing.push('issuerDid')
  if (!state.statusListId) missing.push('statusListId')
  for (const resource of DEMO_RESOURCES) {
    if (!state.dids[resource.key]) missing.push(`dids.${resource.key}`)
  }

  if (missing.length) {
    console.log(`seed incomplete, missing: ${missing.join(', ')}`)
    process.exit(1)
  }
  console.log(`seed looks complete (seeded at ${state.seededAt ?? 'unknown'})`)
}

async function main() {
  if (process.argv.includes('--check')) return check()

  if (process.argv.includes('--reset')) {
    console.log('resetting seed state — identities and credentials will be re-issued')
    clearState()
  }

  await seed()
}

main().catch((error) => {
  console.error('[seed] FATAL', error?.response?.data ?? error?.message ?? error)
  if (process.env.SEED_DEBUG === '1') console.error(error?.stack ?? error)
  process.exit(1)
})
