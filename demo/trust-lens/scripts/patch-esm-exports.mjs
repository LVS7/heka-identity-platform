/**
 * Credo 0.7 pulls in `@verifiables/request-converter`, which is ESM-only: its package.json
 * exports map has an `import` condition but no `default`. Node's CJS resolver (which tsx uses)
 * then fails with ERR_PACKAGE_PATH_NOT_EXPORTED before any of our code runs.
 *
 * Add the missing `default` condition pointing at the same file. Idempotent; runs on postinstall.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const target = 'node_modules/@verifiables/request-converter/package.json'

if (!existsSync(target)) {
  process.exit(0)
}

const pkg = JSON.parse(readFileSync(target, 'utf8'))
const root = pkg.exports?.['.']

if (root && typeof root === 'object' && !root.default && root.import) {
  root.default = root.import
  writeFileSync(target, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log('[patch-esm-exports] added exports["."].default to @verifiables/request-converter')
}
