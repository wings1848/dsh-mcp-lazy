/**
 * Temp directories for the suites, removed when the test process exits.
 *
 * Each suite needs a throwaway `DSH_HOME` for the metadata cache to write into.
 * Every one of them used to call `mkdtempSync` and never remove the result, so a
 * few dozen directories accumulated in the system temp directory on every run —
 * a couple of hundred over a working session. Litter in the developer's
 * environment is a slow-motion bug rather than a visible one, which is exactly
 * the kind that never gets fixed.
 *
 * The `exit` hook is the safety net: `after` hooks do run when an assertion
 * fails, but not when the process dies outright.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const created = new Set<string>()

/**
 * Create a temporary directory that is removed when this process exits.
 *
 * @param prefix - Directory name prefix, ending in a dash by convention.
 * @returns The absolute path of the new directory.
 */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.add(dir)
  return dir
}

/** Remove every directory `tempDir` created. Idempotent. */
export function removeTempDirs(): void {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
  created.clear()
}

process.on('exit', removeTempDirs)
