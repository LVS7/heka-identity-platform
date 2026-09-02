/**
 * Acme Invoice Data — an MCP server that is an OAuth 2.1 resource server, per the MCP
 * authorization specification (revision 2026-07-28).
 *
 * Two tools, deliberately asymmetric:
 *   invoices-list                  routine, no elevated scope — verified at discovery is not
 *                                  the same as locked down
 *   suppliers-export-bank-details  sensitive, requires scope `suppliers:export`
 *
 * The second is what makes the point: the client already has a token and is still refused,
 * with a 403 naming the scope it needs. Least privilege is enforced per call, not per session.
 *
 * Nothing here knows about verifiable credentials. It validates a JWT the way any resource
 * server would — signature, issuer, audience, scope. That the token was minted against a
 * credential presentation is the authorization server's business, which is exactly why this
 * composition needs no bespoke wire format.
 */

import * as dotenv from 'dotenv'
import express, { NextFunction, Request, Response } from 'express'
import { createRemoteJWKSet, jwtVerify } from 'jose'

dotenv.config()

const PORT = Number(process.env.MCP_PORT ?? 4400)
const PUBLIC_URL = process.env.MCP_PUBLIC_URL ?? `http://localhost:${PORT}`
const AS_URL = process.env.AS_PUBLIC_URL ?? `http://localhost:${process.env.AS_PORT ?? 4300}`

const SUPPLIERS_EXPORT_SCOPE = 'suppliers:export'

const INVOICES = [
  { invoice: 'NW-2026-0412', supplier: 'Nordwind Logistik GmbH', amount: '18420.00', currency: 'EUR', status: 'matched' },
  { invoice: 'BV-9921', supplier: 'Baumann Verpackung AG', amount: '4095.50', currency: 'EUR', status: 'matched' },
  { invoice: 'KI-2026-118', supplier: 'Kessler Industrieteile', amount: '31780.00', currency: 'EUR', status: 'matched' },
  { invoice: 'RCH-5540', supplier: 'Rhein Chemie Handel', amount: '2310.75', currency: 'EUR', status: 'held' },
]

const BANK_DETAILS = [
  { supplier: 'Nordwind Logistik GmbH', iban: 'DE44 5001 0517 5407 3249 31', bic: 'INGDDEFFXXX' },
  { supplier: 'Baumann Verpackung AG', iban: 'DE89 3704 0044 0532 0130 00', bic: 'COBADEFFXXX' },
  { supplier: 'Kessler Industrieteile', iban: 'DE02 1203 0000 0000 2020 51', bic: 'BYLADEM1001' },
]

interface AccessToken {
  scope: string
  role?: string
  org?: string
  sub?: string
  exp?: number
}

const jwks = createRemoteJWKSet(new URL(`${AS_URL}/jwks`))

/** RFC 9728 metadata: how a client discovers which authorization server guards this resource. */
function protectedResourceMetadata() {
  return {
    resource: PUBLIC_URL,
    authorization_servers: [AS_URL],
    scopes_supported: [SUPPLIERS_EXPORT_SCOPE],
    bearer_methods_supported: ['header'],
  }
}

function challenge(res: Response, status: number, params: Record<string, string>) {
  const header = `Bearer ${Object.entries(params)
    .map(([key, value]) => `${key}="${value}"`)
    .join(', ')}`
  res.setHeader('WWW-Authenticate', header)
  res.status(status)
}

async function readToken(req: Request): Promise<AccessToken | undefined> {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return undefined

  const { payload } = await jwtVerify(header.slice(7), jwks, {
    issuer: AS_URL,
    // The token must have been minted for *this* resource (RFC 8707). A token for someone
    // else's server is not a token for ours.
    audience: PUBLIC_URL,
  })

  return payload as unknown as AccessToken
}

function hasScope(token: AccessToken | undefined, scope: string): boolean {
  return Boolean(token?.scope?.split(/\s+/).includes(scope))
}

interface ToolResult {
  content: unknown
  authorizedBy?: { role?: string; org?: string }
}

async function callTool(name: string, token: AccessToken | undefined, res: Response): Promise<ToolResult | undefined> {
  if (name === 'invoices-list') {
    // Routine data: no elevated scope. Discovery-time verification already established who
    // this server is; that does not mean everything it holds is sensitive.
    return { content: INVOICES }
  }

  if (name === 'suppliers-export-bank-details') {
    if (!token) {
      challenge(res, 401, {
        resource_metadata: `${PUBLIC_URL}/.well-known/oauth-protected-resource`,
        scope: SUPPLIERS_EXPORT_SCOPE,
      })
      res.json({ error: 'unauthorized', error_description: 'this tool requires authorization' })
      return undefined
    }

    if (!hasScope(token, SUPPLIERS_EXPORT_SCOPE)) {
      // RFC 6750 §3.1 — say which scope would satisfy the call, so the client can step up.
      challenge(res, 403, {
        error: 'insufficient_scope',
        scope: SUPPLIERS_EXPORT_SCOPE,
        resource_metadata: `${PUBLIC_URL}/.well-known/oauth-protected-resource`,
        error_description: 'exporting supplier bank details requires an elevated scope',
      })
      res.json({ error: 'insufficient_scope', required_scope: SUPPLIERS_EXPORT_SCOPE })
      return undefined
    }

    return { content: BANK_DETAILS, authorizedBy: { role: token.role, org: token.org } }
  }

  res.status(404).json({ error: 'unknown_tool', tool: name })
  return undefined
}

function main() {
  const app = express()
  app.use(express.json())

  app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json(protectedResourceMetadata()))

  app.get('/tools', (_req, res) => {
    res.json({
      tools: [
        {
          name: 'invoices-list',
          description: 'List supplier invoices for the period.',
          requiredScope: null,
        },
        {
          name: 'suppliers-export-bank-details',
          description: 'Export supplier bank details. Sensitive.',
          requiredScope: SUPPLIERS_EXPORT_SCOPE,
        },
      ],
    })
  })

  app.post('/tools/:name', async (req: Request, res: Response, next: NextFunction) => {
    try {
      let token: AccessToken | undefined
      try {
        token = await readToken(req)
      } catch (error) {
        // A malformed, expired or wrong-audience token is an unauthenticated request, and the
        // client is told so rather than being left to guess.
        challenge(res, 401, {
          error: 'invalid_token',
          error_description: (error as Error).message,
          resource_metadata: `${PUBLIC_URL}/.well-known/oauth-protected-resource`,
        })
        res.json({ error: 'invalid_token', error_description: (error as Error).message })
        return
      }

      const result = await callTool(String(req.params.name), token, res)
      if (result) {
        console.log(`[mcp] ${req.params.name} ok${result.authorizedBy ? ` (authorized by ${result.authorizedBy.role})` : ''}`)
        res.json(result)
      } else {
        console.log(`[mcp] ${req.params.name} refused (${res.statusCode})`)
      }
    } catch (error) {
      next(error)
    }
  })

  app.listen(PORT, () => {
    console.log(`[mcp] Acme Invoice Data on ${PUBLIC_URL}`)
    console.log(`[mcp] protected resource metadata: ${PUBLIC_URL}/.well-known/oauth-protected-resource`)
    console.log(`[mcp] authorization server: ${AS_URL}`)
  })
}

main()
