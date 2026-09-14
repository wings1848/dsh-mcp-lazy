/**
 * The path helper `scripts/adopt.mjs` builds its staged temp file name from.
 *
 * This is a regression test for a Windows-only failure. The command writes each
 * rewritten patch beside the original, as
 * `join(dirname(file), '.' + basenameOf(file) + '.adopt.' + pid + '.tmp')`, so
 * whatever `basenameOf` returns becomes part of a *file name*. The preceding
 * implementation split on `/` alone, which is not a separator on Windows: there
 * it returned the whole path, and a name containing `C:\…` carries a colon,
 * which Windows forbids in a file name at all. Every `adopt` run on Windows died
 * with `cannot write …` — the message from the one `catch` around the staging
 * loop — and no test could see it, because the CLI is an entry point and the
 * helper was private to it.
 *
 * A Windows-style path is therefore the fixture. The old implementation is
 * wrong about it on *every* host, which is what makes this test red on Linux
 * rather than only on the platform that had the bug.
 */

import assert from 'node:assert/strict'
import { basename, join } from 'node:path'
import { describe, it } from 'node:test'
import { basenameOf } from '../../lib/adopt-paths.js'

/** A Windows path of the shape the harness passes around on that platform. */
const WINDOWS = 'C:\\Users\\me\\.dsh\\cordis.patch.yml'

describe('basenameOf', () => {
  it('returns the final component of a POSIX path', () => {
    assert.equal(basenameOf('/home/me/.dsh/cordis.patch.yml'), 'cordis.patch.yml')
  })

  it('returns the final component of a Windows path', () => {
    assert.equal(basenameOf(WINDOWS), 'cordis.patch.yml')
  })

  it('returns the final component of a Windows path written with slashes', () => {
    assert.equal(basenameOf('C:/Users/me/.dsh/cordis.patch.yml'), 'cordis.patch.yml')
  })

  it('leaves a name with no directory alone', () => {
    assert.equal(basenameOf('cordis.patch.yml'), 'cordis.patch.yml')
  })

  it('returns something that is a file name and not a path', () => {
    for (const file of [WINDOWS, '/home/me/.dsh/cordis.patch.yml', 'profiles/web/p.yml']) {
      const name = basenameOf(file)
      assert.ok(!name.includes('/'), `${name} still contains a separator`)
      assert.ok(!name.includes('\\'), `${name} still contains a separator`)
      // The colon is the character that made the write fail, not the separator
      // itself: it is legal in a POSIX name and fatal in a Windows one.
      assert.ok(!name.includes(':'), `${name} still contains a drive letter`)
    }
  })

  it('yields a staged temp name that is usable on Windows', () => {
    // Mirrors the CLI's own construction. `dirname` is the host's, so this only
    // asserts the half this module owns: the name the helper contributes.
    const staged = join('/tmp', `.${basenameOf(WINDOWS)}.adopt.${process.pid}.tmp`)
    assert.equal(basename(staged), `.cordis.patch.yml.adopt.${process.pid}.tmp`)
  })
})
