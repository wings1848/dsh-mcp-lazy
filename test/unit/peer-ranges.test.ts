/**
 * The `@deepseek-ai/*` peer ranges in `package.json` must accept the versions a
 * harness actually provides.
 *
 * This is a regression test for a metadata-only bug that no runtime test could
 * see. The ranges read `^0.1.5-rc.1` while the harness had moved to the
 * `0.2.0-rc` line, and semver does not let a prerelease of one `0.x` line
 * satisfy a caret range anchored on another: `0.2.0-rc.2` fails `^0.1.5-rc.1`
 * outright. Nothing crashed here — the damage happens at *install* time, where
 * a package manager resolves the unmet peer against the registry and quietly
 * materializes a private `0.1.5-rc.x` copy of `dsh-tools` under `node_modules`.
 * The plugin then builds tool definitions with a different `dsh-tools` instance
 * than the runtime that registers them, which is the class-identity mismatch
 * `scripts/link-dsh.mjs` exists to prevent (see docs/development.md).
 *
 * Two directions are checked, because either one alone leaves a hole:
 *
 * - every version this plugin claims to support satisfies its range — the
 *   written claim, so a narrowed range turns red here even on a machine whose
 *   harness happens to match;
 * - the version actually installed (the linked harness copy locally, the
 *   registry copy in CI) satisfies its range — so a harness that moves on
 *   without this file noticing also turns red.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'

const require = createRequire(import.meta.url)

/** The slice of node-semver this file uses, required to avoid a type-only dep. */
interface SemverLike {
  satisfies(version: string, range: string): boolean
}

const semver = require('semver') as SemverLike

/** The `package.json` fields this file reads. */
interface PackageJson {
  peerDependencies?: Record<string, string>
}

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as PackageJson

/**
 * Versions each harness-synced peer claims to support.
 *
 * `cordis` and `schemastery` are versioned independently of the harness and are
 * covered by the installed-version direction alone.
 */
const SUPPORTED: Record<string, string[]> = {
  '@deepseek-ai/dsh-tools': ['0.1.5-rc.1', '0.1.5-rc.3', '0.2.0-rc.1', '0.2.0-rc.2'],
  '@deepseek-ai/dsh-subprocess': ['0.1.5-rc.1', '0.1.5-rc.3', '0.2.0-rc.1', '0.2.0-rc.2'],
}

/** Every `@deepseek-ai` peer declared in `package.json`. */
function peers(): [string, string][] {
  return Object.entries(pkg.peerDependencies ?? {}).filter(([name]) =>
    name.startsWith('@deepseek-ai/'),
  )
}

describe('peer ranges', () => {
  it('cover every harness version this plugin claims to support', () => {
    assert.ok(peers().length > 0, 'package.json declares no @deepseek-ai peers')
    for (const [name, range] of peers()) {
      for (const version of SUPPORTED[name] ?? []) {
        assert.ok(
          semver.satisfies(version, range),
          `${name}@${version} does not satisfy peer range "${range}"`,
        )
      }
    }
  })

  it('accept the version the harness actually provides', () => {
    for (const [name, range] of peers()) {
      const { version } = require(`${name}/package.json`) as { version: string }
      assert.ok(
        semver.satisfies(version, range),
        `installed ${name}@${version} does not satisfy peer range "${range}" — ` +
          `a package manager would install a second copy at install time`,
      )
    }
  })
})
