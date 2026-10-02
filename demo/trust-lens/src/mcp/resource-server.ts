/**
 * Acme Invoice Data — an MCP server (Streamable HTTP) that is an OAuth 2.1 resource server, per
 * the MCP authorization specification (revision 2026-07-28).
 *
 * Two tools, deliberately asymmetric:
 *   invoices-list                  routine, no elevated scope — verified at discovery is not
 *                                  the same as locked down
 *   suppliers-export-bank-details  sensitive, requires scope `suppliers:export`
 *
 * The scope is enforced in front of the transport, per JSON-RPC request: `initialize`,
 * `tools/list` and unscoped tools pass anonymously; a scoped `tools/call` without a token gets
 * 401, with a token lacking the scope 403 `insufficient_scope` — both naming the scope in
 * `WWW-Authenticate`, which is what lets an ordinary MCP client step up. Least privilege is
 * enforced per call, not per session, so the transport is stateless: a fresh server and
 * transport per request, no session id.
 *
 * Nothing here knows about verifiable credentials. It validates a JWT the way any resource
 * server would — signature, issuer, audience, scope. That the token was minted against a
 * credential presentation is the authorization server's business, which is exactly why this
 * composition needs no bespoke wire format.
 */

import express, { NextFunction, Request, Response } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'

export const SUPPLIERS_EXPORT_SCOPE = 'suppliers:export'

export const TOOLS = {
  'invoices-list': { description: 'List supplier invoices for the period.', requiredScope: null },
  'suppliers-export-bank-details': {
    // The description invites the call on purpose. "Sensitive." alone made the model refuse up
    // front (0/5 calls with gpt-4o-mini), so the step-up never happened. The 401/403 in front of
    // the transport is the control, not the model's restraint.
    description:
      'Export the bank details (IBAN, BIC) of suppliers. Requires the suppliers:export scope: when no token carries it, the server answers with an authorization challenge and the client asks a person to approve with a verifiable credential; just call the tool.',
    requiredScope: SUPPLIERS_EXPORT_SCOPE,
  },
} as const

type ToolName = keyof typeof TOOLS

const INVOICES = [
  {
    invoice: 'NW-2026-0412',
    supplier: 'Nordwind Logistik GmbH',
    amount: '18420.00',
    currency: 'EUR',
    status: 'matched',
  },
  { invoice: 'BV-9921', supplier: 'Baumann Verpackung AG', amount: '4095.50', currency: 'EUR', status: 'matched' },
  {
    invoice: 'KI-2026-118',
    supplier: 'Kessler Industrieteile',
    amount: '31780.00',
    currency: 'EUR',
    status: 'matched',
  },
  { invoice: 'RCH-5540', supplier: 'Rhein Chemie Handel', amount: '2310.75', currency: 'EUR', status: 'held' },
]

const BANK_DETAILS = [
  { supplier: 'Nordwind Logistik GmbH', iban: 'DE44 5001 0517 5407 3249 31', bic: 'INGDDEFFXXX' },
  { supplier: 'Baumann Verpackung AG', iban: 'DE89 3704 0044 0532 0130 00', bic: 'COBADEFFXXX' },
  { supplier: 'Kessler Industrieteile', iban: 'DE02 1203 0000 0000 2020 51', bic: 'BYLADEM1001' },
]

export interface AccessToken {
  scope?: string
  role?: string
  org?: string
  sub?: string
  exp?: number
  client_id?: string
}

export interface ResourceServerOptions {
  publicUrl: string
  asUrl: string
  /** Validate a bearer token and return its claims; throw when it is not acceptable. Injected so the guard is testable without an AS. */
  verifyToken(jwt: string): Promise<AccessToken>
  log?(line: string): void
}

/**
 * RFC 8707 resource identifier: the MCP endpoint itself, as the MCP spec's example does. Not the
 * bare origin — the SDK client sends the resource as `URL.href`, and an origin gains a trailing
 * slash on the way, which would no longer match the audience the resource server checks.
 */
export function resourceIdentifier(publicUrl: string): string {
  return `${publicUrl}/mcp`
}

function challenge(res: Response, status: number, params: Record<string, string>) {
  const header = `Bearer ${Object.entries(params)
    .map(([key, value]) => `${key}="${value}"`)
    .join(', ')}`
  res.setHeader('WWW-Authenticate', header)
  res.status(status)
}

function hasScope(token: AccessToken, scope: string): boolean {
  return Boolean(token.scope?.split(/\s+/).includes(scope))
}

/** The `tools/call` requests in a body (a single message or a batch), with the tool each names. */
function toolCalls(body: unknown): Array<{ name: string; requiredScope: string | null }> {
  const messages = (Array.isArray(body) ? body : [body]).filter(
    (message): message is { method?: unknown; params?: { name?: unknown } } =>
      Boolean(message) && typeof message === 'object'
  )
  return messages
    .filter((message) => message.method === 'tools/call')
    .map((message) => {
      const name = String(message.params?.name ?? '')
      const tool = TOOLS[name as ToolName] as { requiredScope: string | null } | undefined
      return { name, requiredScope: tool?.requiredScope ?? null }
    })
}

function buildServer(log: (line: string) => void): McpServer {
  const server = new McpServer({ name: 'acme-invoice-data', version: '1.0.0' })

  server.registerTool(
    'invoices-list',
    { description: TOOLS['invoices-list'].description, inputSchema: {}, _meta: { requiredScope: null } },
    async () => {
      // Routine data: no elevated scope. Discovery-time verification already established who
      // this server is; that does not mean everything it holds is sensitive.
      log('[mcp] tools/call invoices-list ok')
      return { content: [{ type: 'text', text: JSON.stringify({ rows: INVOICES }) }] }
    }
  )

  server.registerTool(
    'suppliers-export-bank-details',
    {
      description: TOOLS['suppliers-export-bank-details'].description,
      inputSchema: {},
      _meta: { requiredScope: SUPPLIERS_EXPORT_SCOPE },
    },
    async (_args, extra) => {
      // The guard in front of the transport already refused unscoped calls; reaching here
      // without the scope would be a bug, and a bug must not become a grant.
      if (!extra.authInfo?.scopes.includes(SUPPLIERS_EXPORT_SCOPE)) {
        throw new Error('scope suppliers:export is required')
      }
      const { role, org } = (extra.authInfo.extra ?? {}) as { role?: string; org?: string }
      log(`[mcp] tools/call suppliers-export-bank-details ok (authorized by ${role})`)
      return {
        content: [{ type: 'text', text: JSON.stringify({ rows: BANK_DETAILS, authorizedBy: { role, org } }) }],
      }
    }
  )

  return server
}

export function createResourceServer(options: ResourceServerOptions): express.Express {
  const { publicUrl, asUrl, verifyToken } = options
  const log = options.log ?? ((line: string) => console.log(line))
  const metadataUrl = `${publicUrl}/.well-known/oauth-protected-resource`

  /** RFC 9728 metadata: how a client discovers which authorization server guards this resource. */
  const protectedResourceMetadata = {
    resource: resourceIdentifier(publicUrl),
    authorization_servers: [asUrl],
    scopes_supported: [SUPPLIERS_EXPORT_SCOPE],
    bearer_methods_supported: ['header'],
  }

  /**
   * The OAuth semantics, in front of the transport. A present token is always validated (a
   * malformed, expired or wrong-audience one is an unauthenticated request, and the client is
   * told so); a scope is demanded only by the requests that need one.
   */
  async function guardToolScopes(req: Request, res: Response, next: NextFunction) {
    const header = req.headers.authorization
    let token: AccessToken | undefined
    if (header?.startsWith('Bearer ')) {
      try {
        token = await verifyToken(header.slice(7))
      } catch (error) {
        const description = (error as Error).message
        challenge(res, 401, { error: 'invalid_token', error_description: description, resource_metadata: metadataUrl })
        res.json({ error: 'invalid_token', error_description: description })
        log(`[mcp] request refused (401 invalid_token: ${description})`)
        return
      }
    }

    for (const { name, requiredScope } of toolCalls(req.body)) {
      if (!requiredScope) continue
      if (!token) {
        challenge(res, 401, { resource_metadata: metadataUrl, scope: requiredScope })
        res.json({ error: 'unauthorized', error_description: 'this tool requires authorization' })
        log(`[mcp] tools/call ${name} refused (401)`)
        return
      }
      if (!hasScope(token, requiredScope)) {
        // RFC 6750 §3.1 — say which scope would satisfy the call, so the client can step up.
        challenge(res, 403, {
          error: 'insufficient_scope',
          scope: requiredScope,
          resource_metadata: metadataUrl,
          error_description: 'exporting supplier bank details requires an elevated scope',
        })
        res.json({ error: 'insufficient_scope', required_scope: requiredScope })
        log(`[mcp] tools/call ${name} refused (403)`)
        return
      }
    }

    if (token && header) {
      // What the tool handlers see: the SDK passes `req.auth` through as `extra.authInfo`.
      const auth: AuthInfo = {
        token: header.slice(7),
        clientId: token.client_id ?? 'unknown',
        scopes: token.scope?.split(/\s+/).filter(Boolean) ?? [],
        expiresAt: token.exp,
        extra: { role: token.role, org: token.org },
      }
      ;(req as Request & { auth?: AuthInfo }).auth = auth
    }
    next()
  }

  const app = express()
  app.use(express.json())

  app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json(protectedResourceMetadata))
  // The SDK client tries the path-specific document first (RFC 9728 for a resource with a path).
  app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => res.json(protectedResourceMetadata))

  app.post('/mcp', guardToolScopes, async (req, res, next) => {
    try {
      // Stateless: a fresh transport per request, no session id, JSON answers rather than SSE.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => {
        void transport.close()
      })
      await buildServer(log).connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (error) {
      next(error)
    }
  })

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null })
  }
  app.get('/mcp', methodNotAllowed)
  app.delete('/mcp', methodNotAllowed)

  return app
}
