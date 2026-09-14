/**
 * The one path operation the `adopt` command does on a name it just read.
 *
 * This lives in `src/` rather than in `scripts/adopt.mjs` for one reason: the
 * CLI is an entry point, so nothing in it can be imported and tested. The bug
 * this module exists to prevent was a separator assumption that is invisible on
 * the machine it was written on and fatal on the other one, which makes it
 * exactly the kind of code that has to be reachable from a test.
 *
 * `scripts/adopt.mjs` already imports three `lib/` modules, so reaching into
 * `lib/` costs it nothing new — the build was a precondition before this file
 * existed.
 *
 * @module dsh-mcp-lazy/adopt-paths
 */

import { win32 } from 'node:path'

/**
 * A file's name without its directory.
 *
 * The result becomes part of a *file name*: the command stages its rewrite as
 * `join(dirname(file), '.' + basenameOf(file) + '.adopt.' + pid + '.tmp')`, and
 * the `/`-splitting implementation this replaces returned the whole path on
 * Windows, putting `C:\…` — a colon — into that name. Windows forbids a colon
 * in a file name, so every staged write failed there.
 *
 * `win32` is deliberate rather than the host's flavor. On Windows the two are
 * the same thing, so production behavior there is exactly `path.basename`; on
 * POSIX they differ for an input containing a literal backslash. That input is
 * reachable — an earlier draft of this comment claimed otherwise on the grounds
 * that every path here was read from the filesystem, but `--file` is resolved
 * from `argv`, and `touch 'weird\patch.yml'` is legal on POSIX. The consequence
 * is a staged name that differs from the file's own name (`.patch.yml.adopt.…`
 * rather than `.weird\patch.yml.adopt.…`): still a legal name, and it only
 * matters if two files in one plan collide, which `--file` cannot produce.
 * Asking for the Windows flavor unconditionally is what buys the more valuable
 * thing — the Windows contract being *testable* from a POSIX host, which is
 * exactly what the bug above never had.
 *
 * @param file - Any path.
 * @returns The final component.
 */
export function basenameOf(file: string): string {
  return win32.basename(file)
}
