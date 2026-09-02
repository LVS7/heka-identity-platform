/**
 * Registry ingestion helper.
 *
 * mcp-gateway-registry already implements ARD ingestion (it crawls external
 * /.well-known/ai-catalog.json itself), so this is not a crawler — it registers our two
 * publishers as ingestion sources and triggers a sync. See spec/ADR-002 for the constraints
 * that shape it (HTTPS only, host allowlist for non-public IPs, publisher-domain anchoring).
 *
 * The registry stays trust-neutral: relevance scores only, never a trust assertion. The
 * Trust Lens re-fetches each publisher's catalog and attestation directly when verifying,
 * so nothing here is on the trust path.
 */

import * as dotenv from 'dotenv'

dotenv.config()

async function main() {
  // TODO(Phase 1.4): POST /api/federation/config/default/ai_catalog/sources for acme + pro,
  // then POST /api/federation/ai_catalog/sync; `--status` reports per-source counts.
  throw new Error('Not implemented yet — see plan Phase 1.4 and spec/ADR-002')
}

main().catch((e) => {
  console.error('[ard-adapter] FATAL', e?.message ?? e)
  process.exit(1)
})
