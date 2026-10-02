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
  // Not built: the registry cannot run (spec/ADR-002). Once it does, this would POST
  // /api/federation/config/default/ai_catalog/sources for acme + pro, then
  // /api/federation/ai_catalog/sync, with `--status` reporting per-source counts.
  throw new Error('Not implemented — registry ingestion is blocked upstream, see spec/ADR-002')
}

main().catch((e) => {
  console.error('[ard-adapter] FATAL', e?.message ?? e)
  process.exit(1)
})
