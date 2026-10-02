/**
 * Entry point of Acme Invoice Data. The server itself is built in ./resource-server.ts; this file
 * reads the environment, wires the JWT check to the authorization server's JWKS and listens.
 */

import * as dotenv from 'dotenv'
import { createRemoteJWKSet, jwtVerify } from 'jose'

import { listenOrExit } from '../shared/listen'
import { AccessToken, createResourceServer, resourceIdentifier } from './resource-server'

dotenv.config()

const PORT = Number(process.env.MCP_PORT ?? 4400)
const PUBLIC_URL = process.env.MCP_PUBLIC_URL ?? `http://localhost:${PORT}`
const AS_URL = process.env.AS_PUBLIC_URL ?? `http://localhost:${process.env.AS_PORT ?? 4300}`

const jwks = createRemoteJWKSet(new URL(`${AS_URL}/jwks`))

async function verifyToken(jwt: string): Promise<AccessToken> {
  const { payload } = await jwtVerify(jwt, jwks, {
    issuer: AS_URL,
    // The token must have been minted for *this* resource (RFC 8707). A token for someone
    // else's server is not a token for ours.
    audience: resourceIdentifier(PUBLIC_URL),
  })
  return payload as AccessToken
}

listenOrExit(createResourceServer({ publicUrl: PUBLIC_URL, asUrl: AS_URL, verifyToken }), PORT, 'mcp', () => {
  console.log(`[mcp] Acme Invoice Data on ${resourceIdentifier(PUBLIC_URL)} (Streamable HTTP)`)
  console.log(`[mcp] protected resource metadata: ${PUBLIC_URL}/.well-known/oauth-protected-resource`)
  console.log(`[mcp] authorization server: ${AS_URL}`)
})
