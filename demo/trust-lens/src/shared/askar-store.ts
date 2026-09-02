/**
 * Askar store configuration for agents whose state is disposable.
 *
 * `inMemory: true` is the obvious choice here and it is a trap. Credo turns it into the store URI
 * `sqlite://:memory:?max_connections=1&min_connections=1`, and for `:memory:` the database lives
 * inside the *connection*, not the process. A pool of one connection is not one connection
 * forever: the pool retires it on its idle timer and opens a replacement, and the replacement is
 * a brand-new empty database. Everything provisioned at startup is gone, and the next query fails
 * with `no such table: items` — observed roughly twenty minutes into an idle demo stand, which is
 * exactly the gap between setting the stand up and showing it to someone.
 *
 * Pinning the pool to a single connection fixes the *concurrent* form of this bug (two connections
 * are two unrelated databases) but not the form that unfolds over time. A file in a per-process
 * temp directory is just as disposable and survives reconnection.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function ephemeralSqliteStore(id: string, key: string) {
  const directory = mkdtempSync(join(tmpdir(), 'trust-lens-'))

  process.once('exit', () => {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Nothing useful to do at exit — the directory is under the OS temp dir either way.
    }
  })

  return {
    id,
    key,
    database: {
      type: 'sqlite' as const,
      // One connection is no longer a correctness requirement now that the store is a file,
      // only a way to keep SQLite locking trivial in a demo with no concurrency to speak of.
      config: { path: join(directory, 'store.db'), maxConnections: 1, minConnections: 1 },
    },
  }
}
