#!/usr/bin/env node
/**
 * Point the harness packages this plugin links against at the *running* DSH
 * installation.
 *
 * Why this exists: `@deepseek-ai/dsh-*` are peer dependencies, and the harness
 * supplies them at plugin load time from its own install. If npm also materializes
 * private copies under this package's `node_modules`, the plugin would build tool
 * definitions with a *different* `dsh-tools` instance than the runtime that
 * registers them — a class-identity mismatch that fails confusingly, or silently
 * drifts a release behind (`0.1.5-rc.2` on the registry versus the `0.1.5-rc.1`
 * this harness is actually running).
 *
 * So: symlink the peer packages into `node_modules` from the harness install, and
 * let every other dependency resolve normally. Run automatically by `pretest`.
 *
 * Every peer is located independently. They are siblings under a global bun
 * install, but under pnpm each one lives in its own `node_modules/.pnpm/<pkg>@<ver>`
 * directory — assuming a shared root finds the first package and misses the rest.
 *
 * Usage: node scripts/link-dsh.mjs [--check]
 */

import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Harness packages this plugin imports at runtime. */
const PEER_PACKAGES = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-subprocess', '@deepseek-ai/schemastery']

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const checkOnly = process.argv.includes('--check')

/** Candidate roots for a global DSH installation, most specific first. */
function installRoots() {
  const roots = []
  if (process.env['DSH_INSTALL_ROOT'] !== undefined) roots.push(process.env['DSH_INSTALL_ROOT'])
  if (process.env['BUN_INSTALL'] !== undefined) {
    roots.push(join(process.env['BUN_INSTALL'], 'install', 'global', 'node_modules'))
  }
  roots.push(join(process.env['HOME'] ?? '', '.bun', 'install', 'global', 'node_modules'))
  return roots.filter(root => root !== '')
}

/**
 * Locate one peer package's directory.
 *
 * Tries the global install roots first, then falls back to whatever this
 * process can resolve — which covers a profile-local install, and a CI checkout
 * where the only copies are the registry ones pnpm installed. Resolution is per
 * package because pnpm does not place them side by side.
 *
 * @param name - The package name to locate.
 * @returns Its directory, or undefined when nothing provides it.
 */
function findPeer(name) {
  for (const root of installRoots()) {
    const candidate = join(root, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  try {
    const require = createRequire(join(packageRoot, 'package.json'))
    return dirname(require.resolve(`${name}/package.json`))
  } catch {
    return undefined
  }
}

let linked = 0
let alreadyCorrect = 0
const problems = []
const sources = new Set()

for (const name of PEER_PACKAGES) {
  const target = findPeer(name)
  if (target === undefined) {
    problems.push(`${name}: no installation provides it`)
    continue
  }
  sources.add(dirname(target))

  const link = join(packageRoot, 'node_modules', name)
  if (existsSync(link) || isSymlink(link)) {
    if (isSymlink(link) && readlinkSync(link) === target) {
      alreadyCorrect += 1
      continue
    }
    if (checkOnly) {
      problems.push(`${name}: node_modules copy is not the harness instance`)
      continue
    }
    rmSync(link, { recursive: true, force: true })
  }

  if (checkOnly) {
    problems.push(`${name}: not linked`)
    continue
  }

  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(target, link, 'dir')
  linked += 1
  console.log(`link-dsh: ${name} -> ${target}`)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`link-dsh: ${problem}`)
  // Without a harness there is nothing to link to, and the registry copies pnpm
  // installed are a working substitute — which is what CI relies on. Only
  // `--check` treats that as a failure.
  if (checkOnly) process.exit(1)
}

if (!checkOnly) {
  const where = sources.size === 1 ? [...sources][0] : `${sources.size} locations`
  console.log(`link-dsh: ${linked} linked, ${alreadyCorrect} already correct (from ${where})`)
}

/** Whether a path is a symbolic link, broken or not. */
function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
