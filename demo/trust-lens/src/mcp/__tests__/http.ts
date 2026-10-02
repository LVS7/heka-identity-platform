import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'

import express from 'express'

/** One request against an Express app on a throwaway port — enough for route tests, no extra dependency. */
export async function request(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : {} }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}
