/**
 * Every bare import in the published output resolves from the published manifest.
 *
 * This exists because the opposite shipped. `scripts/adopt.mjs` is a `bin` entry,
 * so it is a *product* of this package, not a development tool — but the YAML
 * parser it needs sat in `devDependencies`, where `npx dsh-mcp-lazy-adopt` never
 * installs it. The import was invisible in development for the worst possible
 * reason: a hoisted copy of `js-yaml` from an unrelated package in the host's
 * `node_modules` happened to sit where Node's resolution walk would find it. On a
 * clean machine the published CLI died on its first statement.
 *
 * So the check is deliberately static and offline. It answers "would this resolve
 * on a machine that installed exactly what the manifest promises?" without
 * needing such a machine, and it covers the whole published surface instead of
 * the one path a smoke test would have exercised.
 *
 * `peerDependencies` count as declared: those are supplied by the host, which is
 * what the plugin contract says they are for. Node builtins are skipped by their
 * `node:` prefix, and nothing else may be skipped — an exception list here would
 * be the same bug with a receipt.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = dirname(dirname(here))

/** Every `.js` file under a directory, recursively. */
function javascriptFiles(directory: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) found.push(...javascriptFiles(path))
    else if (name.endsWith('.js')) found.push(path)
  }
  return found
}

/**
 * Every module specifier a file imports or re-exports.
 *
 * `import` statements are anchored to the start of a line so the many `import`
 * mentions inside comments and JSDoc are not mistaken for code; dynamic
 * `import(...)` is matched anywhere, because that form has no line shape.
 *
 * @param source - The file's text.
 * @returns The raw specifiers, in source order.
 */
function specifiersIn(source: string): string[] {
  const found: string[] = []
  const patterns = [
    /^[ \t]*import\s[^'"\n]*from\s*['"]([^'"]+)['"]/gmu,
    /^[ \t]*import\s*['"]([^'"]+)['"]/gmu,
    /^[ \t]*export\s[^'"\n]*from\s*['"]([^'"]+)['"]/gmu,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) found.push(match[1])
    }
  }
  return found
}

/**
 * The package a bare specifier belongs to.
 *
 * @param specifier - A module specifier.
 * @returns The package name, or `undefined` when it is relative or a builtin.
 */
function packageOf(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
    return undefined
  }
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier
  return parts[0]
}

describe('the published manifest declares everything the published code imports', () => {
  const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    files?: string[]
  }

  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])

  it('declares js-yaml, which the CLI imports at runtime (regression)', () => {
    // The exact failure this file was written for: `lib/adopt-compose.js` and
    // `lib/adopt-patch.js` both import it, and `scripts/adopt.mjs` reaches them.
    assert.ok(
      Object.hasOwn(manifest.dependencies ?? {}, 'js-yaml'),
      'the adopt CLI is a published bin entry, so its YAML parser belongs in dependencies',
    )
  })

  it('declares every bare specifier in lib/ and scripts/', () => {
    const roots = [join(repo, 'lib'), join(repo, 'scripts')]
    const missing: string[] = []
    let seen = 0

    for (const root of roots) {
      for (const file of javascriptFiles(root)) {
        for (const specifier of specifiersIn(readFileSync(file, 'utf8'))) {
          const name = packageOf(specifier)
          if (name === undefined) continue
          seen += 1
          if (!declared.has(name)) missing.push(`${relative(repo, file)} imports ${name}`)
        }
      }
    }

    assert.ok(seen > 0, 'the scan found no imports at all, which means it is looking in the wrong place')
    assert.deepEqual(missing, [], 'these imports would fail on a clean install')
  })

  it('ships every directory the scan reads', () => {
    // A `files` list that omits `lib` or `scripts` would make the check above
    // vacuous for consumers while still passing here.
    assert.ok(manifest.files?.includes('lib'), 'lib/ is the package entry point')
    assert.ok(manifest.files?.includes('scripts'), 'scripts/ holds the published bin entry')
  })
})
