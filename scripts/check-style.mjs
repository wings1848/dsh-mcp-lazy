#!/usr/bin/env node
/**
 * The one `.editorconfig` rule no installed tool enforces: a 100-column limit.
 *
 * `.editorconfig` has declared `max_line_length = 100` since the first commit.
 * Nothing checked it, and 113 lines across 23 files had drifted past it. oxlint
 * is this repository's linter, but it has no `max-len` rule — its length rules
 * are `max-lines` and `max-lines-per-function`, which cap a file or a function
 * rather than a line. So the column limit gets this: one file, no dependencies,
 * reading the number out of `.editorconfig` so the two cannot disagree.
 *
 * Markdown is out of scope on purpose. A table row or a prose link cannot be
 * wrapped without changing how it renders, and `README.md` alone has 17 lines
 * over the limit that are correct as written.
 *
 * Usage:
 *   node scripts/check-style.mjs [--json]
 *
 * Exit codes:
 *   0  every file is within the limits, or only baselined files are not
 *   1  a file that is not baselined has an offender
 *
 * @module dsh-mcp-lazy/scripts/check-style
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository root, derived from this file so the cwd does not matter. */
const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** Directories to walk. Markdown and the design documents are not in them. */
const ROOTS = ['src', 'scripts', 'test']

/** Extensions the rules apply to. */
const EXTENSIONS = new Set(['.ts', '.mjs', '.json', '.yml', '.yaml'])

/** The fallback when `.editorconfig` cannot be read. */
const DEFAULT_MAX_LENGTH = 100

/**
 * Per-file caps on how many lines may sit over the column limit.
 *
 * A burn-down, not an exemption. The number is what the file carried when this
 * check landed, and a file whose count *grows* fails the run — the first shape
 * of this was a set of whole-file exemptions, and it was too weak to be worth
 * having: a 185-column line added to an exempt file passed `check` and CI, and
 * the exempt set happened to contain every file the change it was written
 * alongside had touched.
 *
 * A file absent from this map must be clean, so any offender fails: that covers
 * every new file, and covered `scripts/adopt.mjs` when this landed. Lowering a
 * number is how the burn-down is recorded; deleting the entry means the file is
 * clean.
 */
const BASELINE = new Map([
  ['scripts/link-dsh.mjs', 1],
  ['scripts/measure-token-savings.mjs', 4],
  ['src/adopt-patch.ts', 4],
  ['src/adopt.ts', 11],
  ['src/command.ts', 5],
  ['src/connection.ts', 2],
  ['src/direct-tools.ts', 3],
  ['src/index.ts', 2],
  ['src/naming.ts', 1],
  ['src/proxy-tool.ts', 14],
  ['src/registry.ts', 9],
  ['src/schema.ts', 1],
  ['src/search-ranking.ts', 4],
  ['test/unit/adopt-command.test.ts', 8],
  ['test/unit/adopt-rows.test.ts', 6],
  ['test/unit/adopt-run.test.ts', 5],
  ['test/unit/connection.e2e.test.ts', 5],
  ['test/unit/declared-deps.test.ts', 1],
  ['test/unit/direct-tools.test.ts', 1],
  ['test/unit/metadata-cache.test.ts', 1],
  ['test/unit/naming.test.ts', 1],
  ['test/unit/plugin-load.test.ts', 2],
  ['test/unit/proxy-tool.test.ts', 12],
])

/**
 * The column limit, read from the file that declares it.
 *
 * Parsed rather than duplicated so that changing `.editorconfig` changes this
 * check too. A missing or unparsable file falls back to the default, which is
 * what a reader of `.editorconfig` would assume.
 *
 * @returns The `max_line_length` of the `[*]` section.
 */
function maxLineLength() {
  let text
  try {
    text = readFileSync(join(root, '.editorconfig'), 'utf8')
  } catch {
    return DEFAULT_MAX_LENGTH
  }
  const match = /^\s*max_line_length\s*=\s*(\d+)\s*$/m.exec(text)
  return match === null ? DEFAULT_MAX_LENGTH : Number(match[1])
}

/**
 * Every file under {@link ROOTS} whose extension is checked.
 *
 * @returns Repo-relative paths, with `/` separators.
 */
function sourceFiles() {
  const found = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(path)
      } else if (EXTENSIONS.has(extname(entry.name))) {
        found.push(relative(root, path))
      }
    }
  }
  for (const directory of ROOTS) {
    try {
      if (statSync(join(root, directory)).isDirectory()) walk(join(root, directory))
    } catch {
      // A checkout without one of the directories is not an error.
    }
  }
  return found.sort()
}

/**
 * Every way one file breaks the rules `.editorconfig` declares for it.
 *
 * @param file - A repo-relative path.
 * @param limit - The column limit.
 * @returns One line number per offender, in file order.
 */
function offendersIn(file, limit) {
  const text = readFileSync(join(root, file), 'utf8')
  if (text === '') return []
  const offenders = []
  const lines = text.split('\n')

  // `insert_final_newline = true`: a trailing `` after the last newline is
  // what a correctly terminated file looks like, so drop it before counting.
  if (lines.at(-1) === '') lines.pop()
  else offenders.push({ line: lines.length, what: 'no newline at end of file' })

  for (const [index, line] of lines.entries()) {
    const number = index + 1
    if (line.endsWith('\r')) offenders.push({ line: number, what: 'CRLF line ending' })
    // `trim_trailing_whitespace = true`, which `.editorconfig` turns back off
    // for Markdown only — and Markdown is not walked.
    if (/[ \t]+$/.test(line)) offenders.push({ line: number, what: 'trailing whitespace' })
    if (line.length > limit) {
      offenders.push({ line: number, what: `${line.length} columns (limit ${limit})` })
    }
  }
  return offenders
}

/**
 * Report the run.
 *
 * @param args - `--json` prints the same facts as JSON.
 * @returns The exit code.
 */
function main(args) {
  const limit = maxLineLength()
  const failing = []
  const baselined = []

  for (const file of sourceFiles()) {
    const offenders = offendersIn(file, limit)
    if (offenders.length === 0) continue
    const allowed = BASELINE.get(file)
    if (allowed === undefined) {
      failing.push({ file, offenders })
      continue
    }
    if (offenders.length > allowed) {
      failing.push({ file, offenders, allowed })
      continue
    }
    // The longest line is the interesting one in a summary; the count is the
    // number a burn-down moves.
    baselined.push({ file, count: offenders.length })
  }

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ limit, failing, baselined }, null, 2)}\n`)
  } else {
    if (baselined.length > 0) {
      const lines = baselined.reduce((total, entry) => total + entry.count, 0)
      process.stderr.write(
        `style: ${lines} line(s) over ${limit} columns in ${baselined.length} baselined ` +
          `file(s), not failing the run: ${baselined.map(entry => entry.file).join(', ')}\n`,
      )
    }
    for (const { file, offenders, allowed } of failing) {
      if (allowed !== undefined) {
        process.stdout.write(
          `${file}: ${offenders.length} line(s) over ${limit} columns, ` +
            `${offenders.length - allowed} more than the baselined ${allowed}\n`,
        )
      }
      for (const { line, what } of offenders) {
        process.stdout.write(`${file}:${line}: ${what}\n`)
      }
    }
    // A stale entry is worth knowing about but is not a failure: the point of
    // the list is that it shrinks, and a parallel change reflowing a file is
    // not something this check should punish.
    const stale = [...BASELINE.keys()].filter(file => !baselined.some(entry => entry.file === file))
    if (stale.length > 0) {
      process.stderr.write(
        `style: ${stale.length} baseline entr(y/ies) no longer needed, delete them: ` +
          `${stale.join(', ')}\n`,
      )
    }
    if (failing.length === 0) {
      process.stdout.write(`style: clean (${limit} columns, ${sourceFiles().length} files)\n`)
    }
  }

  return failing.length === 0 ? 0 : 1
}

process.exitCode = main(process.argv.slice(2))
