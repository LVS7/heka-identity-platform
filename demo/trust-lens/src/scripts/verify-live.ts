/**
 * Run the verification engine against the live publisher sites — the end-to-end acceptance check.
 *
 * Expects `yarn seed` to have run and `yarn sites` to be serving. Prints one verdict per
 * discovered entry, exactly as the Trust Lens UI will.
 *
 * Run: yarn verify:live
 */

import * as dotenv from 'dotenv'

import { AiCatalog, Verdict } from '../core/types'
import { verifyEntry } from '../core/verify'
import { createVerifierAgent, verifierDependencies } from '../shared/credential-verifier'
import { ACME_DOMAIN, PRO_DOMAIN } from '../shared/demo-config'
import { loadState } from '../seed/state'

dotenv.config()

const SITES_PORT = process.env.SITES_PORT ?? '443'
const suffix = SITES_PORT === '443' ? '' : `:${SITES_PORT}`

/** The demo serves TLS with a self-signed development certificate. */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

async function fetchCatalog(domain: string): Promise<AiCatalog> {
  const response = await fetch(`https://${domain}${suffix}/.well-known/ai-catalog.json`)
  if (!response.ok) throw new Error(`catalog fetch failed for ${domain}: HTTP ${response.status}`)
  return (await response.json()) as AiCatalog
}

const BADGE: Record<string, string> = {
  [Verdict.Verified]: 'VERIFIED       ',
  [Verdict.SubjectMismatch]: 'SUBJECT_MISMATCH',
  [Verdict.Revoked]: 'REVOKED        ',
}

async function main() {
  const state = loadState()
  if (!state.issuerDid) throw new Error('no seed state — run `yarn seed` first')

  console.log(`trusted issuer (this relying party's anchor): ${state.issuerDid}\n`)

  const agent = createVerifierAgent()
  await agent.initialize()

  try {
    const options = {
      trustedIssuers: [state.issuerDid],
      ...verifierDependencies(agent),
    }

    let verified = 0
    let refused = 0
    const verdicts = new Map<string, Verdict>()

    for (const domain of [ACME_DOMAIN, PRO_DOMAIN]) {
      const catalog = await fetchCatalog(domain)
      console.log(`${domain} — ${catalog.entries.length} entr${catalog.entries.length === 1 ? 'y' : 'ies'}`)

      for (const entry of catalog.entries) {
        // Verification uses the domain the catalog was actually served from, never a value
        // taken from the catalog itself.
        const result = await verifyEntry(entry, { servingDomain: domain }, options)
        const badge = BADGE[result.verdict] ?? result.verdict.padEnd(16)
        verdicts.set(entry.displayName, result.verdict)

        console.log(`  ${badge}  ${entry.displayName}`)
        if (result.verdict === Verdict.Verified) {
          verified++
          console.log(
            `                    operator: ${result.evidence.operatorLegalName} (${result.evidence.operatorDomain})`
          )
        } else {
          refused++
          console.log(`                    ${result.evidence.failureDetail}`)
        }
      }
      console.log()
    }

    console.log(`${verified} verified, ${refused} refused`)

    // These two hold regardless of what has been revoked, and are what the demo argues:
    // a genuine resource is usable, and the lookalike never is.
    const agentUsable = verdicts.get('Acme Invoice Agent') === Verdict.Verified
    const lookalikeRefused = verdicts.get('AcmeInvoice Pro Agent') === Verdict.SubjectMismatch
    const mcpVerdict = verdicts.get('Acme Invoice Data')

    if (mcpVerdict === Verdict.Revoked) {
      console.log('note: the MCP passport is currently revoked — per-resource granularity, the agent is unaffected')
    }

    console.log(
      agentUsable && lookalikeRefused
        ? 'RESULT: PASS — the lookalike is refused, the genuine agent is usable'
        : 'RESULT: FAIL — expected the genuine agent VERIFIED and the lookalike SUBJECT_MISMATCH'
    )
    if (!(agentUsable && lookalikeRefused)) process.exit(1)
  } finally {
    await agent.shutdown()
  }
}

main().catch((error) => {
  console.error('[verify:live] FATAL', error?.message ?? error)
  process.exit(1)
})
