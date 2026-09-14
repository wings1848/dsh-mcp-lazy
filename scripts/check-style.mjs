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
 * Files carrying lines over the column limit *before* this check existed.
 *
 * A baseline, not an exemption: these files belong to other workstreams, so
 * reflowing them here would collide with work in flight. Their offenders are
 * still counted and printed — they just do not fail the run. Deleting a file
 * from this list is how the burn-down is recorded.
 *
 * `scripts/adopt.mjs` is deliberately absent: it was reflowed when this landed.
 */
const BASELINE = new Set([
  'scripts/link-dsh.mjs',
  'scripts/measure-token-savings.mjs',
  'src/adopt-patch.ts',
  'src/adopt.ts',
  'src/command.ts',
  'src/connection.ts',
  'src/direct-tools.ts',
  'src/index.ts',
  'src/naming.ts',
  'src/proxy-tool.ts',
  'src/registry.ts',
  'src/schema.ts',
  'src/search-ranking.ts',
  'test/unit/adopt-command.test.ts',
  'test/unit/adopt-rows.test.ts',
  'test/unit/adopt-run.test.ts',
  'test/unit/connection.e2e.test.ts',
  'test/unit/declared-deps.test.ts',
  'test/unit/direct-tools.test.ts',
  'test/unit/metadata-cache.test.ts',
  'test/unit/naming.test.ts',
  'test/unit/plugin-load.test.ts',
  'test/unit/proxy-tool.test.ts',
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
  let baselineUsed = 0

  for (const file of sourceFiles()) {
    const offenders = offendersIn(file, limit)
    if (offenders.length === 0) continue
    if (!BASELINE.has(file)) {
      failing.push({ file, offenders })
      continue
    }
    baselineUsed += 1
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
    for (const { file, offenders } of failing) {
      for (const { line, what } of offenders) {
        process.stdout.write(`${file}:${line}: ${what}\n`)
      }
    }
    // A stale entry is worth knowing about but is not a failure: the point of
    // the list is that it shrinks, and a parallel change reflowing a file is
    // not something this check should punish.
    const stale = [...BASELINE].filter(file => !baselined.some(entry => entry.file === file))
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
