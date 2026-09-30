/**
 * Resource cards published by the demo publishers.
 *
 * These are the artifacts an ARD entry's `url` dereferences to, and what the Resource Passport
 * pins via `resource_card_digest` — so a publisher cannot swap the card after attestation.
 */

import { AiCatalog, AiCatalogEntry } from '../core/types'
import { DemoResource, attestationUrl, cardUrl, entryIdentifier } from '../shared/demo-config'

export const IN_TASK_OID4VP_EXTENSION_URI =
  'https://github.com/DSRCorporation/a2a-oid4vp-in-task-auth-extension/tree/main/v1'

export function buildAgentCard(resource: DemoResource, agentUrl: string) {
  return {
    name: resource.displayName,
    description: resource.description,
    url: agentUrl,
    provider: { organization: resource.operator.legalName, url: `https://${resource.domain}` },
    version: '1.0.0',
    protocolVersion: '1.0',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
      extensions: [
        {
          uri: IN_TASK_OID4VP_EXTENSION_URI,
          description:
            'Requires an OpenID for Verifiable Presentations (OID4VP) authorization for sensitive task steps',
          required: false,
          params: { oid4vpVersions: ['1.0'] },
        },
      ],
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [
      {
        id: 'invoice-reconciliation',
        name: 'Supplier invoice reconciliation',
        description: 'Reconciles supplier invoices and prepares a payment export.',
        tags: resource.tags,
        examples: resource.representativeQueries,
        inputModes: ['text'],
        outputModes: ['text'],
      },
    ],
    supportsAuthenticatedExtendedCard: false,
  }
}

/**
 * The MCP server's card. Its transport URL is where the Trust Lens connects once the card is
 * verified — the passport pins the card by digest, so the URL a client trusts is the one the
 * publisher attested, never one a registry or an env var supplies.
 */
export function buildMcpServerCard(resource: DemoResource, mcpUrl: string) {
  return {
    name: resource.displayName,
    description: resource.description,
    version: '1.0.0',
    provider: { organization: resource.operator.legalName, url: `https://${resource.domain}` },
    transport: { type: 'streamable-http', url: `${mcpUrl}/mcp` },
    tools: [
      { name: 'invoices-list', description: 'List supplier invoices for a period.' },
      {
        name: 'suppliers-export-bank-details',
        description: 'Export supplier bank details. Sensitive: requires an elevated scope.',
      },
    ],
  }
}

export function buildCard(resource: DemoResource, agentUrl: string, mcpUrl: string) {
  return resource.resourceType === 'a2a-agent'
    ? buildAgentCard(resource, agentUrl)
    : buildMcpServerCard(resource, mcpUrl)
}

export function buildCatalogEntry(resource: DemoResource, identity: string, attestationDigest: string): AiCatalogEntry {
  return {
    identifier: entryIdentifier(resource),
    displayName: resource.displayName,
    type: resource.mediaType,
    url: cardUrl(resource),
    description: resource.description,
    tags: resource.tags,
    capabilities: resource.capabilities,
    representativeQueries: resource.representativeQueries,
    trustManifest: {
      identity,
      identityType: 'did',
      attestations: [
        {
          // Proposed VC Attestation Profile for ARD (see spec/ADR-001): the uri dereferences
          // to an SD-JWT VC and the digest covers the fetched bytes.
          type: 'application/vc+sd-jwt',
          uri: attestationUrl(resource),
          digest: attestationDigest,
        },
      ],
    },
  }
}

export function buildCatalog(host: string, entries: AiCatalogEntry[]): AiCatalog {
  return { specVersion: '1.0', host, entries }
}
