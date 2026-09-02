/**
 * Development TLS for the publisher sites.
 *
 * ARD ingestion is HTTPS-only, and catalogs should be served from clean HTTPS origins even in
 * dev, so the sites need a certificate. Rather than requiring mkcert to be installed, the demo
 * generates one self-signed certificate covering both publisher domains and writes it to
 * `certs/`. Point Node at it with NODE_EXTRA_CA_CERTS (or import it once into your trust store
 * to browse the publisher sites directly).
 *
 * If you prefer mkcert, drop `demo-cert.pem` / `demo-key.pem` into `certs/` and this is skipped.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import selfsigned from 'selfsigned'

export interface DemoTls {
  cert: string
  key: string
  certPath: string
}

const CERTS_DIR = resolve(process.cwd(), 'certs')
const CERT_PATH = resolve(CERTS_DIR, 'demo-cert.pem')
const KEY_PATH = resolve(CERTS_DIR, 'demo-key.pem')

export function ensureDemoTls(domains: string[]): DemoTls {
  if (existsSync(CERT_PATH) && existsSync(KEY_PATH)) {
    return { cert: readFileSync(CERT_PATH, 'utf8'), key: readFileSync(KEY_PATH, 'utf8'), certPath: CERT_PATH }
  }

  const altNames = [
    ...domains.map((domain) => ({ type: 2, value: domain })),
    // Wildcards so nested subdomains (and the docker aliases) are covered too.
    ...domains.map((domain) => ({ type: 2, value: `*.${domain}` })),
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
  ]

  const pems = selfsigned.generate([{ name: 'commonName', value: domains[0] }], {
    days: 825,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'subjectAltName', altNames },
    ],
  })

  mkdirSync(CERTS_DIR, { recursive: true })
  writeFileSync(CERT_PATH, pems.cert)
  writeFileSync(KEY_PATH, pems.private)

  console.log(`[sites] generated a development certificate for ${domains.join(', ')}`)
  console.log(`[sites] trust it with: NODE_EXTRA_CA_CERTS=${CERT_PATH}`)

  return { cert: pems.cert, key: pems.private, certPath: CERT_PATH }
}
