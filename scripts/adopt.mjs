#!/usr/bin/env node
/**
 * Move `@deepseek-ai/dsh-mcp-client` servers into this plugin, in place.
 *
 * Why this exists: every producer of MCP configuration in this ecosystem writes
 * a `dsh-mcp-client` row — the config-manager panel hardcodes the package name,
 * `@hyzyn/dsh-codegraph` writes a managed row, and a hand-written config follows
 * the same convention. Such a row registers each MCP tool as a real tool, so its
 * schemas enter every request. A server listed in both places therefore cancels
 * the saving this plugin exists for, with no error and nothing to notice.
 *
 * What it does, in one pass:
 *
 * 1. reads what is *actually* mounted, from `dsh --profile <p> --dump-config`,
 *    because a patch file is an operation list and cannot answer that alone;
 * 2. plans a text-level edit per row: mark the original `disabled: true` in
 *    place, and append the server to this plugin's `servers` list;
 * 3. writes nothing unless `--write` is given, and refuses to write at all when
 *    anything it does not understand is in the way.
 *
 * Usage:
 *   node scripts/adopt.mjs [--profile web] [--dsh-home <path>] [--file <path>]
 *                         [--write] [--json] [--allow-skip]
 *
 * Exit codes:
 *   0  nothing to do, or a successful dry run, or a successful `--write`
 *   1  rows were skipped and `--allow-skip` was not given
 *   2  the environment refused: unreadable file, unrecognised structure, or a
 *      file that changed between planning and writing (nothing was written)
 *
 * @module dsh-mcp-lazy/scripts/adopt
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { LAZY_PACKAGE, LAZY_PLUGIN, NATIVE_MCP_PLUGIN, parseComposedDump } from '../lib/adopt-compose.js'
import { findNativeRow } from '../lib/adopt-patch.js'
import { basenameOf } from '../lib/adopt-paths.js'
import { applyEdits, planAdoption, resolveNativeRows, summarizePlan } from '../lib/adopt.js'

/** Exit codes, named so the intent survives a refactor. */
const EXIT = {
  ok: 0,
  skipped: 1,
  environment: 2,
}

/** This file's directory, for locating the repository root. */
const here = dirname(fileURLToPath(import.meta.url))

/** Print a message to stderr. */
function report(message) {
  process.stderr.write(`${message}\n`)
}

/** Stop with an environment error: nothing has been written at this point. */
class EnvironmentError extends Error {}

/**
 * Parse the command line.
 *
 * @param argv - Arguments after the script name.
 * @returns The options.
 * @throws {EnvironmentError} On an unknown flag or a missing value.
 */
function parseArgs(argv) {
  const options = {
    profile: 'web',
    dshHome: undefined,
    file: undefined,
    write: false,
    json: false,
    allowSkip: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new EnvironmentError(`${arg} needs a value`)
      }
      index += 1
      return next
    }
    switch (arg) {
      case '--profile':
        options.profile = value()
        break
      case '--dsh-home':
        options.dshHome = value()
        break
      case '--file':
        options.file = value()
        break
      case '--write':
        options.write = true
        break
      case '--json':
        options.json = true
        break
      case '--allow-skip':
        options.allowSkip = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new EnvironmentError(`unknown argument "${arg}" (try --help)`)
    }
  }
  return options
}

/**
 * Resolve the harness home the way the harness itself does.
 *
 * @param configured - The `--dsh-home` value, when given.
 * @returns An absolute path.
 */
function resolveHome(configured) {
  if (configured !== undefined) return resolve(configured.replace(/^~(?=\/|$)/, homedir()))
  const fromEnv = process.env['DSH_HOME']
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return resolve(fromEnv.trim().replace(/^~(?=\/|$)/, homedir()))
  }
  return join(homedir(), '.dsh')
}

/**
 * Run `dsh --profile <p> --dump-config`.
 *
 * The dump is the truth the plan is built on: it applies the same patch
 * algorithm a boot does, without booting and without evaluating `!!js`. Its
 * stderr is kept rather than dropped — a patch whose target id does not exist
 * yet is skipped with a warning and a zero exit code, so silence here is the
 * only thing distinguishing "applied" from "silently ignored".
 *
 * @param profile - The profile to dump.
 * @param env - The environment to run in, with `DSH_HOME` set.
 * @returns The dump text and the stderr text.
 * @throws {EnvironmentError} When `dsh` is missing or fails.
 */
function dumpConfig(profile, env) {
  const result = spawnSync('dsh', ['--profile', profile, '--dump-config'], {
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error !== undefined && result.error !== null) {
    throw new EnvironmentError(`could not run dsh: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new EnvironmentError(
      `dsh --profile ${profile} --dump-config exited ${result.status}\n${result.stderr ?? ''}`,
    )
  }
  return { dump: result.stdout ?? '', warnings: result.stderr ?? '' }
}

/**
 * Read a file, or explain which file could not be read.
 *
 * @param file - The path.
 * @returns The contents.
 * @throws {EnvironmentError} When it cannot be read.
 */
function readOrFail(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    throw new EnvironmentError(`cannot read ${file}: ${error.message}`)
  }
}

/**
 * Build everything the plan needs, without writing anything.
 *
 * @param options - The parsed command line.
 * @returns The plan and the files it would touch.
 * @throws {EnvironmentError} When the environment is not usable.
 */
function buildPlan(options) {
  const dshHome = resolveHome(options.dshHome)
  const profileDir = join(dshHome, 'profiles', options.profile)
  const homePatch = join(dshHome, 'cordis.patch.yml')
  const profilePatch = join(profileDir, 'cordis.patch.yml')

  if (options.file !== undefined) {
    // Isolated mode: read one patch file directly, with no composed tree. Used
    // by the tests, and the only mode that works without `dsh` installed.
    const file = resolve(options.file)
    const text = readOrFail(file)
    const rows = nativeRowsFromFile(text, file, dshHome)
    return {
      plan: planFor(rows, existingServersFrom(text), hasRow(text, LAZY_PLUGIN) ? file : undefined),
      warnings: '',
      dshHome,
      profileDir,
      homePatch,
      profilePatch,
    }
  }

  const env = { ...process.env, DSH_HOME: dshHome }
  const { dump, warnings } = dumpConfig(options.profile, env)
  const composed = parseComposedDump(dump, dshHome, profileDir)
  // Both layers can hold a row, and which one does is a fact about the files
  // rather than about the dump's provenance marker, so both are offered.
  const rows = resolveNativeRows(composed.nativeRows, readOrFail, [homePatch, profilePatch])

  // A row that only a `--patch` overlay contributes has no file this command is
  // allowed to edit. v1 reports it rather than reaching into an overlay.
  const overlayNames = composed.overlays
    .map(row => row.entry.config?.serverName)
    .filter(name => typeof name === 'string')

  const plan = planFor(rows, composed.gateway?.servers ?? [], composed.gateway?.file)

  return { plan, warnings, overlayNames, dshHome, profileDir, homePatch, profilePatch }
}

/**
 * Plan an adoption, or report that there is nothing to plan.
 *
 * The distinction matters: asking for the `servers` list of a row that does not
 * exist is an error, and it must not be raised for a run that was never going to
 * adopt anything. A machine with no native rows at all is the normal case for
 * this command, not a broken environment.
 *
 * @param rows - The native rows found.
 * @param existingServers - This plugin's configured servers.
 * @param gatewayFile - The file carrying this plugin's row, if any.
 * @returns The plan.
 */
function planFor(rows, existingServers, gatewayFile) {
  if (rows.length === 0) return emptyPlan()
  return planAdoption({
    nativeRows: rows,
    existingServers,
    ...(gatewayFile === undefined ? {} : { gatewayFile }),
    read: readOrFail,
  })
}

/** An empty plan, for a run with nothing to consider. */
function emptyPlan() {
  return { adoptions: [], disables: [], skips: [], blocked: 0, edits: [], files: [] }
}

/**
 * Find the native rows in one patch file, without a composed tree.
 *
 * @param text - The file's contents.
 * @param file - The file's path.
 * @param options - The parsed command line, for the profile name.
 * @param dshHome - The resolved home.
 * @param profileDir - The resolved profile directory.
 * @returns The rows found.
 */
function nativeRowsFromFile(text, file, dshHome) {
  const rows = []
  // Every `- id:` in the file is a candidate; the ones that name the other
  // plugin are the rows this command exists for.
  const ids = [...text.matchAll(/^\s*-\s+id:\s*(.+)$/gm)].map(match => match[1].trim())
  const layer = resolve(file) === resolve(dshHome, 'cordis.patch.yml') ? 'home' : 'profile'
  const seen = new Set()
  for (const rawId of ids) {
    const id = rawId.replace(/^['"]|['"]$/g, '')
    if (seen.has(id)) continue
    seen.add(id)
    const found = findNativeRow(text, id, file, layer)
    // The row's own `name` is on the item that carries the id, which may be an
    // item of a sequence nested under `insert:` — so it is read from the parsed
    // item, not from the wrapper the scan happened to match.
    if (found === undefined) continue
    if (rowPluginName(found) !== NATIVE_MCP_PLUGIN) continue
    rows.push(found)
  }
  return rows
}

/**
 * The plugin a row mounts, whether it is written bare or under `insert:`.
 *
 * @param row - The row to read.
 * @returns The package name, or undefined.
 */
function rowPluginName(row) {
  const fields = row.fields
  if (typeof fields['name'] === 'string') return fields['name']
  return undefined
}

/**
 * Read this plugin's own `servers` list out of one patch file.
 *
 * @param text - The file's contents.
 * @param file - The file's path.
 * @returns The configured servers, or an empty list.
 */
function existingServersFrom(text) {
  if (!hasRow(text, LAZY_PLUGIN)) return []
  const { servers } = serversOf(text)
  return servers
}

/**
 * Whether a patch file declares a row with this id.
 *
 * @param text - The file's contents.
 * @param id - The loader id.
 * @returns True when the id appears as a row.
 */
function hasRow(text, id) {
  return new RegExp(`^\\s*-\\s+id:\\s*['"]?${id}['"]?\\s*$`, 'm').test(text)
}

/**
 * Parse the `servers` list under `id: mcp-lazy` in a raw patch file.
 *
 * Only used for the isolated `--file` mode; the composed tree is the real
 * source and this is a convenience for a single-file test or an inspection.
 *
 * @param text - The file's contents.
 * @returns The servers found, or an empty list.
 */
function serversOf(text) {
  const servers = []
  const start = new RegExp(`^\\s*-\\s+id:\\s*['"]?${LAZY_PLUGIN}['"]?\\s*$`, 'm').exec(text)
  if (start === null) return { servers }
  const rest = text.slice(start.index)
  const key = /^(\s*)servers:\s*$/m.exec(rest)
  if (key === null) return { servers }
  const keyIndent = key[1].length
  const body = rest.slice(key.index + key[0].length)
  const names = [...body.matchAll(new RegExp(`^\\s{${keyIndent + 1},}-\\s+serverName:\\s*(.+)$`, 'gm'))]
  for (const match of names) servers.push({ serverName: match[1].trim().replace(/^['"]|['"]$/g, '') })
  return { servers }
}

/** A SHA-256 digest of a file, or undefined when it does not exist. */
function digestOf(file) {
  if (!existsSync(file)) return undefined
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * Apply a plan to disk, atomically and only when nothing moved underneath it.
 *
 * Three rules, each of which has a failure it prevents:
 *
 * - the digest taken at plan time is re-checked before writing, so a concurrent
 *   `dsh-config-manager` rewrite is detected instead of overwritten;
 * - each file is written to a temporary sibling and renamed, so a crash leaves
 *   either the old file or the new one, never half of one;
 * - a backup is taken first, because one of these files is the user's only
 *   configuration and an edit script is not something to run without a way back.
 *
 * @param plan - The plan to apply.
 * @param digests - The digests recorded when the plan was built.
 * @returns The backups taken, and the files written.
 * @throws {EnvironmentError} When a file changed, or cannot be written.
 */
function writePlan(plan, digests) {
  const backups = []
  const written = []

  // Check *every* file before writing any of them: a half-applied plan is worse
  // than no plan, because the rows it did not reach still cost the tokens.
  for (const file of plan.files) {
    const current = digestOf(file)
    if (current !== digests.get(file)) {
      throw new EnvironmentError(
        `${file} changed since it was read (expected ${digests.get(file) ?? 'the file to exist'}, found ${current ?? 'nothing'}); nothing was written`,
      )
    }
  }

  const stamp = timestamp()
  const staged = []
  let failed = undefined
  try {
    // Phase 1: back up every file and write every replacement beside it. All the
    // fallible work happens here, so a permission problem, a full disk or a name
    // already taken is discovered while the user's files are still untouched.
    for (const file of plan.files) {
      failed = file
      const original = readOrFail(file)
      const rewritten = applyEdits(
        original,
        plan.edits.filter(edit => edit.file === file),
      )
      const backup = `${file}.bak-${stamp}-before-adopt`
      const temporary = join(dirname(file), `.${basenameOf(file)}.adopt.${process.pid}.tmp`)
      const mode = statSync(file).mode & 0o777
      copyFileSync(file, backup)
      backups.push(backup)
      writeFileSync(temporary, rewritten, { mode })
      staged.push({ file, temporary, backup })
    }

    // Phase 2: swap them in. A rename within a directory is the one step that
    // cannot fail for the reasons phase 1 can, so this loop either completes or
    // leaves a state the rollback below can undo.
    for (const entry of staged) {
      failed = entry.file
      renameSync(entry.temporary, entry.file)
      written.push(entry.file)
    }
    failed = undefined
  } catch (error) {
    // Restore what was already swapped in, and drop the staged copies. Nothing
    // was ever written without a backup, so this restores exactly the original
    // bytes — which is what "exit 2 means nothing was written" has to mean.
    const restored = []
    const stranded = []
    for (const file of written) {
      const entry = staged.find(candidate => candidate.file === file)
      /* v8 ignore next -- every written file was staged */
      if (entry === undefined) continue
      try {
        copyFileSync(entry.backup, file)
        restored.push(file)
      } catch {
        stranded.push(file)
      }
    }
    for (const entry of staged) rmSync(entry.temporary, { force: true })
    const recovery =
      stranded.length > 0
        ? `; ${restored.length} file(s) were restored, but ${stranded.join(', ')} could not be — recover ${stranded.length === 1 ? 'it' : 'them'} from the .bak-${stamp}-before-adopt ${stranded.length === 1 ? 'file' : 'files'}`
        : restored.length > 0
          ? `; ${restored.length} file(s) were restored from their backups`
          : '; no file was modified'
    throw new EnvironmentError(
      `cannot write ${failed ?? 'the configuration'}: ${error.message}${recovery}`,
    )
  }

  return { backups, written }
}

/** The `yyyymmdd-hhmmss` stamp the backup name carries. */
function timestamp() {
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

/**
 * Profiles that read the file being edited but do not mount this plugin.
 *
 * The two halves of this command can land in different layers, and that is not a
 * detail: the native row usually lives in the **home** patch, which every profile
 * reads, while `id: mcp-lazy` lives in one profile's patch. Disabling the home
 * row therefore takes the server away from every *other* profile too — and those
 * profiles have no gateway to receive it, so they simply lose the capability,
 * with nothing anywhere saying so.
 *
 * The plan itself cannot see this: it never looks at profiles other than the one
 * it was asked about. So the answer is computed here, at render time, from the
 * one fact that decides it — whether a profile's manifest lists this package.
 *
 * @param plan - The plan about to be rendered.
 * @param homePatch - Absolute path of the home layer's patch file.
 * @param dshHome - Absolute `$DSH_HOME`.
 * @returns Profile names that would lose the service, sorted; empty when the
 *   disabled rows all live inside the profile's own layer.
 */
function profilesLosingService(plan, homePatch, dshHome) {
  const shareTheBlast = plan.disables.some(disable => resolve(disable.file) === resolve(homePatch))
  if (!shareTheBlast) return []

  const profilesDir = join(dshHome, 'profiles')
  let names
  try {
    names = readdirSync(profilesDir)
  } catch {
    // No profiles directory to reason about is not a reason to fail the plan.
    return []
  }

  const losing = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    const manifest = join(profilesDir, name, 'package.json')
    let parsed
    try {
      parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    } catch {
      // Not a profile (a stray directory, an unreadable manifest): silence is
      // right here, because guessing would name a profile that does not exist.
      continue
    }
    if (parsed?.dsh?.profile === undefined) continue
    const bundles = parsed.dsh.profile.bundles
    if (!Array.isArray(bundles) || !bundles.includes(LAZY_PACKAGE)) losing.push(name)
  }
  return losing.sort()
}

/** Print the plan for a human. */
function renderPlan(result, options) {
  const { plan } = result
  const lines = []
  lines.push(`dsh-mcp-lazy adopt — profile ${options.profile}`)
  if (options.file !== undefined) {
    // Naming the ambient `$DSH_HOME` paths here would read as "about to edit
    // those", which in this mode is exactly what is not happening.
    lines.push(`  single file   ${resolve(options.file)}`)
  } else {
    lines.push(`  home patch    ${result.homePatch}`)
    lines.push(`  profile patch ${result.profilePatch}`)
  }
  lines.push('')
  if (plan.edits.length === 0 && plan.skips.length === 0) {
    lines.push('Nothing to do: no @deepseek-ai/dsh-mcp-client row needs attention.')
    return lines.join('\n')
  }
  lines.push(summarizePlan(plan))
  if (plan.blocked === 0 && plan.edits.length === 0) {
    return lines.join('\n')
  }
  const losing =
    options.file === undefined && result.dshHome !== undefined
      ? profilesLosingService(plan, result.homePatch, result.dshHome)
      : []
  if (losing.length > 0) {
    const what = plan.adoptions.map(adoption => adoption.source.serverName ?? adoption.source.id)
    lines.push('')
    lines.push(
      `  ⚠ the row being disabled lives in the home layer ${result.homePatch}, which every profile reads.`,
    )
    lines.push(
      `    ${losing.length} other profile(s) do not mount ${LAZY_PACKAGE}, so they would lose ` +
        `${what.join(', ')} with no replacement: ${losing.join(', ')}.`,
    )
    lines.push(
      `    Mount ${LAZY_PACKAGE} in those profiles, or move the row into ${options.profile}'s own layer, ` +
        'if they need it.',
    )
  }
  if (result.overlayNames !== undefined && result.overlayNames.length > 0) {
    lines.push('')
    lines.push(
      `  note    ${result.overlayNames.length} row(s) come from a --patch overlay and are not handled: ` +
        result.overlayNames.join(', '),
    )
  }
  if (result.warnings.trim() !== '') {
    lines.push('')
    lines.push('dsh reported during composition:')
    lines.push(
      result.warnings
        .trim()
        .split('\n')
        .map(line => `  ${line}`)
        .join('\n'),
    )
  }
  lines.push('')
  if (options.write) {
    lines.push(`Wrote ${plan.files.length} file(s).`)
  } else {
    lines.push('Dry run. Nothing was written; pass --write to apply.')
  }
  return lines.join('\n')
}

/** Print the plan as JSON. */
function renderJson(result, options, digests, backups) {
  const { plan } = result
  return JSON.stringify(
    {
      profile: options.profile,
      files: plan.files,
      // `wrote` is true whenever `--write` was given, even for a run with nothing
      // to do — it is the flag, not an outcome. Here is the outcome beside it.
      wrote: options.write,
      writeRequested: options.write,
      filesWritten: backups.length,
      blocked: plan.blocked,
      backups,
      digests: Object.fromEntries([...digests].map(([file, digest]) => [file, digest ?? null])),
      adoptions: plan.adoptions.map(adoption => ({
        file: adoption.source.file,
        id: adoption.source.id,
        entry: adoption.entry,
      })),
      disables: plan.disables,
      skips: plan.skips.map(skip => ({
        file: skip.source.file,
        id: skip.source.id,
        serverName: skip.source.serverName ?? null,
        reason: skip.reason,
        detail: skip.detail ?? null,
      })),
      edits: plan.edits,
      overlayRows: result.overlayNames ?? [],
      warnings: result.warnings.trim() === '' ? [] : result.warnings.trim().split('\n'),
    },
    null,
    2,
  )
}

const USAGE = `dsh-mcp-lazy adopt — move @deepseek-ai/dsh-mcp-client servers into this plugin

Usage:
  node scripts/adopt.mjs [options]

Options:
  --profile <name>    profile to read (default: web)
  --dsh-home <path>   override $DSH_HOME
  --file <path>       handle one patch file only, without composing (testing)
  --write             apply the plan; without it this is a dry run
  --json              print the machine-readable plan
  --allow-skip        do not treat skipped rows as a failure
  -h, --help          this text

Exit codes: 0 nothing to do or success, 1 rows were skipped, 2 environment error.

Run this while the host is stopped: the web profile reloads its patch layer
live, and dsh-config-manager rewrites the same file from its own state.`

/** The entry point. */
function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    report(`adopt: ${error.message}`)
    return EXIT.environment
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return EXIT.ok
  }

  let result
  try {
    result = buildPlan(options)
  } catch (error) {
    report(`adopt: ${error.message}`)
    return EXIT.environment
  }

  const digests = new Map()
  for (const file of result.plan.files) digests.set(file, digestOf(file))

  let backups = []
  if (options.write && result.plan.files.length > 0) {
    try {
      const outcome = writePlan(result.plan, digests)
      backups = outcome.backups
    } catch (error) {
      report(`adopt: ${error.message}`)
      return EXIT.environment
    }
  }

  process.stdout.write(
    options.json
      ? `${renderJson(result, options, digests, backups)}\n`
      : `${renderPlan(result, options, digests)}\n`,
  )

  if (result.plan.blocked > 0 && !options.allowSkip) {
    if (!options.json) {
      report('')
      report(
        `adopt: ${result.plan.blocked} row(s) should have moved and did not, so this is not a ` +
          'complete move. Read the reasons above, fix what you can, or pass --allow-skip to accept them.',
      )
    }
    return EXIT.skipped
  }
  return EXIT.ok
}

/**
 * Whether this module is the program being run.
 *
 * `import.meta.main` is not available on every supported Node, so the paths are
 * compared instead — and compared **with symlinks resolved**, because that is how
 * this file is reached in practice. `bin` entries are symlinks on POSIX, so
 * `argv[1]` is `<prefix>/bin/dsh-mcp-lazy-adopt` while `import.meta.url` is the
 * real path in the package; without `realpathSync` the comparison is false, the
 * CLI silently does nothing, and it exits 0.
 *
 * @returns True when this file was launched as the entry point.
 */
function isMain() {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  const self = fileURLToPath(import.meta.url)
  try {
    return realpathSync(invoked) === realpathSync(self)
  } catch {
    // A path that cannot be resolved cannot be this file.
    return resolve(invoked) === resolve(self)
  }
}

if (isMain()) {
  process.exitCode = main()
}

export { main, parseArgs, buildPlan, hasRow, serversOf, profilesLosingService, EXIT }
