/**
 * Capture a real Finance Data Officer presentation from the live Identity Service.
 *
 * Fixtures come from the live service (CLAUDE.md): the SD-JWT decoder is tested against a
 * presentation Heka actually verified, not one invented in a test. This creates a verification
 * session with the presentation definition the agent uses, presents the officer credential from
 * the in-process holder, reads the verified session back and writes the vp_token to
 * src/core/__tests__/fixtures/officer-presentation.sd-jwt. Needs Heka and a complete seed.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import * as dotenv from 'dotenv'

import { identityServiceFromEnv } from '../shared/identity-service'
import { officerPresentationDefinition } from '../shared/presented-credential'
import { SimulatedWallet } from '../shared/simulated-wallet'

dotenv.config()

const FIXTURE = resolve(process.cwd(), 'src/core/__tests__/fixtures/officer-presentation.sd-jwt')

/** The same request the agent makes: role and org, nothing else. */
const OFFICER_PRESENTATION_DEFINITION = officerPresentationDefinition(
  'Capture a presentation fixture for the decoder tests'
)

async function main() {
  const identityService = identityServiceFromEnv()
  const verifierDid = await identityService.prepareWallet()

  const { verificationSession, authorizationRequest } = await identityService.createVerificationSession({
    publicVerifierId: verifierDid,
    requestSigner: { method: 'did', did: verifierDid },
    presentationExchange: { definition: OFFICER_PRESENTATION_DEFINITION },
  })
  console.log(`[capture] session ${verificationSession.id}`)

  const wallet = new SimulatedWallet(identityService)
  await wallet.initialize()
  await wallet.present(authorizationRequest)

  // Verification is asynchronous on Heka's side; poll briefly rather than trust the submit.
  let record = await identityService.getVerificationSession(verificationSession.id)
  for (let attempt = 0; attempt < 20 && record.state !== 'ResponseVerified'; attempt++) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    record = await identityService.getVerificationSession(verificationSession.id)
  }
  if (record.state !== 'ResponseVerified') throw new Error(`session did not verify (state ${record.state})`)

  const raw = record.authorizationResponsePayload?.vp_token
  console.log(`[capture] vp_token is ${Array.isArray(raw) ? `an array of ${raw.length}` : typeof raw}`)
  const compact = Array.isArray(raw) ? raw[0] : raw
  if (typeof compact !== 'string' || !compact.includes('~')) {
    throw new Error(`unexpected vp_token shape: ${JSON.stringify(raw).slice(0, 200)}`)
  }

  mkdirSync(dirname(FIXTURE), { recursive: true })
  writeFileSync(FIXTURE, `${compact}\n`)
  console.log(`[capture] sharedAttributes: ${JSON.stringify(record.sharedAttributes)}`)
  console.log(`[capture] wrote ${FIXTURE} (${compact.length} chars, ${compact.split('~').length - 1} separators)`)

  await wallet.shutdown()
}

main().catch((error) => {
  console.error('[capture] FATAL', error?.response?.data ?? error?.message ?? error)
  process.exit(1)
})
