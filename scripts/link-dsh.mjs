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
 * So: symlink the peer packages into `node_modules` from the global install, and
 * let every other dependency resolve normally. Run automatically by `npm test`.
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

/** Locate the global DSH installation that provides these packages. */
function findDshInstall() {
  const candidates = []
  if (process.env['DSH_INSTALL_ROOT'] !== undefined) candidates.push(process.env['DSH_INSTALL_ROOT'])
  if (process.env['BUN_INSTALL'] !== undefined) {
    candidates.push(join(process.env['BUN_INSTALL'], 'install', 'global', 'node_modules'))
  }
  candidates.push(join(process.env['HOME'] ?? '', '.bun', 'install', 'global', 'node_modules'))

  for (const candidate of candidates) {
    if (candidate !== '' && existsSync(join(candidate, '@deepseek-ai', 'dsh-tools', 'package.json'))) {
      return candidate
    }
  }

  // Last resort: wherever this process can resolve the package from, which covers
  // a profile-local install.
  try {
    const require = createRequire(join(packageRoot, 'package.json'))
    const resolved = require.resolve('@deepseek-ai/dsh-tools/package.json')
    return dirname(dirname(dirname(resolved)))
  } catch {
    return undefined
  }
}

const dshInstall = findDshInstall()
if (dshInstall === undefined || dshInstall === '') {
  console.error(
    'link-dsh: could not find a DSH installation providing @deepseek-ai/dsh-tools.\n' +
      'Set DSH_INSTALL_ROOT to the directory containing @deepseek-ai/.',
  )
  process.exit(checkOnly ? 1 : 0)
}

let linked = 0
let alreadyCorrect = 0
const problems = []

for (const name of PEER_PACKAGES) {
  const target = join(dshInstall, name)
  if (!existsSync(target)) {
    problems.push(`${name}: not present in ${dshInstall}`)
    continue
  }

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
  if (checkOnly) process.exit(1)
}

if (!checkOnly) {
  console.log(
    `link-dsh: ${linked} linked, ${alreadyCorrect} already correct (harness at ${dshInstall})`,
  )
}

/** Whether a path is a symbolic link, broken or not. */
function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
