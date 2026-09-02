/**
 * The demo's cast, in one place. The seed, the publisher sites and the Trust Lens all read
 * from here so a rename never drifts between the catalog, the credential and the UI.
 */

/**
 * Reserved TLDs (RFC 2606), matching the design document.
 *
 * Not `.localhost`: RFC 6761 makes that name special, and resolvers hard-map it to loopback —
 * so a container asking for `acme-invoices.localhost` never reaches the publisher container,
 * whatever DNS aliases say. `.example` has no such treatment.
 */
export const ACME_DOMAIN = process.env.ACME_DOMAIN ?? 'acme-invoices.example'
export const PRO_DOMAIN = process.env.PRO_DOMAIN ?? 'acme-invoices-ai.example'

export const TRUSTCO = {
  name: 'TrustCo',
  legalName: 'TrustCo Certification GmbH',
} as const

export interface DemoResource {
  /** Key in the seed state file. */
  key: 'acmeAgent' | 'acmeMcp' | 'pro'
  site: 'acme-site' | 'pro-site'
  domain: string
  namespace: string
  name: string
  displayName: string
  description: string
  tags: string[]
  capabilities: string[]
  representativeQueries: string[]
  resourceType: 'a2a-agent' | 'mcp-server'
  /** IANA media type used by the catalog entry. */
  mediaType: string
  /** File served under /.well-known/ for the resource card. */
  cardFile: string
  /** File served under /.well-known/attestations/ for the hosted passport. */
  attestationFile: string
  operator: { legalName: string; domain: string; kybRef: string }
}

const ACME_OPERATOR = {
  legalName: 'Acme Corp GmbH',
  domain: ACME_DOMAIN,
  kybRef: 'KYB-DE-2024-ACME-0417',
}

/**
 * Pro is a lookalike publisher: a spec-valid catalog on a plausible domain, its own DID, and a
 * genuine TrustCo-issued credential — replayed from Acme's agent. Everything checks out except
 * the subject binding, which is the point.
 */
const PRO_OPERATOR = {
  legalName: 'AcmeInvoice Pro Ltd',
  domain: PRO_DOMAIN,
  kybRef: 'KYB-XX-0000-UNKNOWN',
}

export const DEMO_RESOURCES: DemoResource[] = [
  {
    key: 'acmeAgent',
    site: 'acme-site',
    domain: ACME_DOMAIN,
    namespace: 'finance',
    name: 'invoice-agent',
    displayName: 'Acme Invoice Agent',
    description: 'Autonomous supplier invoice reconciliation and payment preparation.',
    tags: ['finance', 'invoices', 'a2a'],
    capabilities: ['invoice-reconciliation', 'payment-preparation'],
    representativeQueries: ['reconcile supplier invoices', 'prepare a payment export'],
    resourceType: 'a2a-agent',
    mediaType: 'application/a2a-agent-card+json',
    cardFile: 'agent-card.json',
    attestationFile: 'agent-passport.sd-jwt',
    operator: ACME_OPERATOR,
  },
  {
    key: 'acmeMcp',
    site: 'acme-site',
    domain: ACME_DOMAIN,
    namespace: 'finance',
    name: 'invoice-data',
    displayName: 'Acme Invoice Data',
    description: 'Supplier invoice intake, validation and reconciliation data via MCP.',
    tags: ['finance', 'invoices', 'mcp'],
    capabilities: ['invoice-data', 'supplier-data'],
    representativeQueries: ['look up a supplier invoice', 'supplier bank details'],
    resourceType: 'mcp-server',
    mediaType: 'application/mcp-server-card+json',
    cardFile: 'mcp-server-card.json',
    attestationFile: 'mcp-passport.sd-jwt',
    operator: ACME_OPERATOR,
  },
  {
    key: 'pro',
    site: 'pro-site',
    domain: PRO_DOMAIN,
    namespace: 'finance',
    name: 'invoice-agent',
    displayName: 'AcmeInvoice Pro Agent',
    description: 'Autonomous supplier invoice reconciliation and payment preparation.',
    tags: ['finance', 'invoices', 'a2a'],
    capabilities: ['invoice-reconciliation', 'payment-preparation'],
    representativeQueries: ['reconcile supplier invoices', 'prepare a payment export'],
    resourceType: 'a2a-agent',
    mediaType: 'application/a2a-agent-card+json',
    cardFile: 'agent-card.json',
    attestationFile: 'agent-passport.sd-jwt',
    operator: PRO_OPERATOR,
  },
]

export const OFFICER_CREDENTIAL = {
  configurationId: 'FinanceDataOfficer',
  role: 'Finance Data Officer',
  org: TRUSTCO.legalName,
  /** Claims the operator discloses when authorizing a task. */
  disclosed: ['role', 'org'],
} as const

export function entryIdentifier(resource: DemoResource): string {
  return `urn:air:${resource.domain}:${resource.namespace}:${resource.name}`
}

export function cardUrl(resource: DemoResource): string {
  return `https://${resource.domain}/.well-known/${resource.cardFile}`
}

export function attestationUrl(resource: DemoResource): string {
  return `https://${resource.domain}/.well-known/attestations/${resource.attestationFile}`
}

export function catalogUrl(domain: string): string {
  return `https://${domain}/.well-known/ai-catalog.json`
}
