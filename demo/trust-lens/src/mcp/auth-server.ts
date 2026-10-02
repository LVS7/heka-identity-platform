/**
 * Entry point of the Authorization Server for the MCP path. The server itself — OAuth 2.1 with a
 * credential presentation where the login form would be — is in ./authorization-server.ts; this
 * file reads the environment and listens.
 */

import * as dotenv from 'dotenv'

import { identityServiceFromEnv } from '../shared/identity-service'
import { listenOrExit } from '../shared/listen'
import { AuthorizationServer, createAuthorizationApp } from './authorization-server'

dotenv.config()

const PORT = Number(process.env.AS_PORT ?? 4300)
const ISSUER = process.env.AS_PUBLIC_URL ?? `http://localhost:${PORT}`
/** Short by design: a revoked credential must stop mattering within minutes, not hours. */
const TOKEN_TTL_SECONDS = Number(process.env.AS_TOKEN_TTL ?? 300)

async function main() {
  const as = new AuthorizationServer(identityServiceFromEnv(), { issuer: ISSUER, tokenTtlSeconds: TOKEN_TTL_SECONDS })
  await as.initialize()

  listenOrExit(createAuthorizationApp(as), PORT, 'as', () => {
    console.log(`[as] Authorization Server on ${ISSUER}`)
    console.log(`[as] token TTL ${TOKEN_TTL_SECONDS}s — a revoked credential stops mattering within minutes`)
  })
}

main().catch((error) => {
  console.error('[as] FATAL', error?.response?.data ?? error?.message ?? error)
  process.exit(1)
})
