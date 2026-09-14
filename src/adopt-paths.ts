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
 * POSIX they differ only for an input containing a literal backslash, which
 * this process cannot produce — every path arriving here was read from the
 * filesystem by this same process, so it carries the host's own separators.
 * Asking for the Windows flavor unconditionally is what lets the Windows
 * contract be *tested* from a POSIX host, which is the entire reason the bug
 * above reached a release: with the host's flavor, the only input that
 * distinguishes the two behaviors is unreachable in CI.
 *
 * @param file - Any path.
 * @returns The final component.
 */
export function basenameOf(file: string): string {
  return win32.basename(file)
}
