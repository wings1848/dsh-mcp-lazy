/**
 * The adopt command as a program: its file effects and its exit codes.
 *
 * The unit tests next door prove the *plan* is right. These prove the parts that
 * only exist once something runs: that a dry run writes nothing at all, that a
 * refused run writes nothing even with `--write`, that a second run is a no-op,
 * and that a missing file stops it rather than being created.
 *
 * The claim being defended is narrow and easy to lose: this command edits the
 * user's only configuration, so "nothing happened" has to be a checkable fact
 * rather than an intention. Every assertion here compares bytes or digests, not
 * messages.
 *
 * Two modes are exercised, and they are genuinely different code paths:
 *
 * - `--file <path>` reads one patch file, with no composed tree, and handles the
 *   part of the job that lives in that file: the in-place `disabled` line.
 * - the default mode runs `dsh --profile <p> --dump-config` and does the whole
 *   job. A stub `dsh` on `PATH` stands in for the real one, emitting a composed
 *   dump written against the same fixture files — so the command reads a real
 *   composition, and the test needs no harness installation.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../helpers/tmp.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = dirname(dirname(here))
const script = join(repo, 'scripts', 'adopt.mjs')

/** A home layer with one managed row, a comment, and an unrelated block. */
const HOME = [
  '# --- dsh-codegraph mcp managed (auto-generated; do not edit) ---',
  '- insert:',
  '    - id: mcp-codegraph-managed',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: codegraph',
  '        transport: stdio',
  '        command: codegraph',
  '        args:',
  '          - serve',
  "          - '--mcp'",
  '# --- end dsh-codegraph mcp managed ---',
  '',
  '# --- keep me: a hand-written block ---',
  '- insert:',
  '    - id: rtk',
  "      name: '@wingsbutterfly/dsh-rtk'",
  '      config:',
  '        enabled: true',
  '',
].join('\n')

/** A profile layer carrying this plugin's config, with one server already in it. */
const PROFILE = [
  '# Your patch layer for this dsh profile.',
  '- id: mcp-lazy',
  '  config:',
  '    idleTimeout: 10',
  '    servers:',
  '      - serverName: phonemcp',
  '        transport: stdio',
  '        command: /usr/bin/python',
  '',
].join('\n')

/** Where the fixture's files live, freshly created per suite. */
let sandbox = ''
let homePatch = ''
let profilePatch = ''
let stubBin = ''

/**
 * Restore the fixture: both files back to their starting bytes, and every backup
 * and edit from an earlier case gone.
 *
 * The suite shares one sandbox because creating it installs the stub `dsh`, and
 * a leftover backup would make "no backup was taken" pass for the wrong reason.
 */
function resetFixtures(): void {
  for (const directory of [sandbox, dirname(profilePatch)]) {
    for (const name of readdirSync(directory)) {
      if (name.includes('before-adopt')) rmSync(join(directory, name), { force: true })
    }
  }
  writeFileSync(homePatch, HOME)
  writeFileSync(profilePatch, PROFILE)
  writeFileSync(join(sandbox, 'stub-dump.yml'), stubDump())
}

/**
 * The composed dump the stub `dsh` prints.
 *
 * Written against the fixture files, the way the real dump attributes each row
 * to the layer that patched it: the managed row to the home file, this plugin's
 * row to the profile file, with its one configured server.
 *
 * @returns YAML text in the `dsh --dump-config` shape.
 */
function stubDump(): string {
  return [
    '# == @deepseek-ai/dsh-base',
    '- id: webserver',
    "  name: '@deepseek-ai/dsh-webserver'",
    `# == ${homePatch}`,
    '- id: mcp-codegraph-managed',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: codegraph',
    '    transport: stdio',
    '    command: codegraph',
    '    args:',
    '      - serve',
    "      - '--mcp'",
    `# == dsh-mcp-lazy, patched by ${profilePatch}`,
    '- id: mcp-lazy',
    '  config:',
    '    idleTimeout: 10',
    '    servers:',
    '      - serverName: phonemcp',
    '        transport: stdio',
    '        command: /usr/bin/python',
    '',
  ].join('\n')
}

/**
 * Run the command.
 *
 * @param args - Arguments after the script name.
 * @param options - `composed` puts the stub `dsh` on `PATH`.
 * @returns The exit code and both output streams.
 */
function adopt(
  args: string[],
  options: { composed?: boolean } = {},
): { status: number; stdout: string; stderr: string } {
  const env = { ...process.env }
  if (options.composed === true) env['PATH'] = `${stubBin}:${process.env['PATH'] ?? ''}`
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** A SHA-256 digest of a file. */
function digest(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Every backup file the fixture has produced. */
function backups(): string[] {
  return [
    ...readdirSync(sandbox).filter(name => name.includes('before-adopt')),
    ...readdirSync(join(sandbox, 'profiles', 'web')).filter(name => name.includes('before-adopt')),
  ].sort()
}

before(() => {
  sandbox = tempDir('dsh-mcp-lazy-adopt-')
  homePatch = join(sandbox, 'cordis.patch.yml')
  profilePatch = join(sandbox, 'profiles', 'web', 'cordis.patch.yml')
  mkdirSync(dirname(profilePatch), { recursive: true })

  // A `dsh` that only answers `--dump-config`, so the whole command can be run
  // without a harness installation. Anything else is a failure the test wants to
  // see, not a silent pass.
  stubBin = join(sandbox, 'bin')
  mkdirSync(stubBin)
  writeFileSync(
    join(stubBin, 'dsh'),
    `#!/bin/sh\nif [ "$3" != "--dump-config" ]; then echo "stub dsh: unexpected args: $@" >&2; exit 9; fi\ncat ${JSON.stringify(join(sandbox, 'stub-dump.yml'))}\n`,
  )
  chmodSync(join(stubBin, 'dsh'), 0o755)
  writeFileSync(join(sandbox, 'stub-dump.yml'), stubDump())

  resetFixtures()
})

after(() => {
  // `tempDir` removes the directory when the process exits.
})

describe('adopt.mjs — dry run (AD1)', () => {
  it('writes nothing, and says what it would do', () => {
    resetFixtures()
    const before = { home: digest(homePatch), profile: digest(profilePatch) }
    const beforeStat = statSync(homePatch)
    const result = adopt(['--dsh-home', sandbox], { composed: true })

    assert.equal(result.status, 0)
    assert.match(result.stdout, /adopt {3}codegraph/)
    assert.match(result.stdout, /disable mcp-codegraph-managed/)
    assert.match(result.stdout, /Dry run/)
    assert.equal(digest(homePatch), before.home)
    assert.equal(digest(profilePatch), before.profile)
    assert.equal(statSync(homePatch).mtimeMs, beforeStat.mtimeMs)
    assert.deepEqual(backups(), [])
  })

  it('exits 0 with nothing to do', () => {
    resetFixtures()
    // A profile layer with no native row at all: nothing to plan.
    const result = adopt(['--dsh-home', sandbox, '--file', profilePatch])
    assert.equal(result.status, 0)
    assert.match(result.stdout, /Nothing to do/)
  })

  it('prints a machine-readable plan with --json', () => {
    resetFixtures()
    const result = adopt(['--dsh-home', sandbox, '--json'], { composed: true })
    assert.equal(result.status, 0)
    const plan = JSON.parse(result.stdout)
    assert.equal(plan.wrote, false)
    assert.equal(plan.blocked, 0)
    assert.deepEqual(plan.files, [homePatch, profilePatch])
    assert.equal(plan.adoptions.length, 1)
    assert.equal(plan.adoptions[0].entry.serverName, 'codegraph')
    // The edit script is arithmetic: offsets and the exact replacement. Applying
    // it by hand must reproduce the file this command would write.
    const text = readFileSync(homePatch, 'utf8')
    const disable = plan.edits.find((edit: { kind: string }) => edit.kind === 'disable')
    assert.equal(
      text.slice(0, disable.start) + disable.replacement + text.slice(disable.end),
      HOME.replace(
        "      name: '@deepseek-ai/dsh-mcp-client'\n",
        () => "      name: '@deepseek-ai/dsh-mcp-client'\n      disabled: true\n",
      ),
    )
  })
})

describe('adopt.mjs — --write (AD2, AD3, AD9)', () => {
  it('writes both files, and backs each one up first', () => {
    resetFixtures()
    const result = adopt(['--dsh-home', sandbox, '--write'], { composed: true })
    assert.equal(result.status, 0)

    const nextHome = readFileSync(homePatch, 'utf8')
    assert.match(nextHome, /\n {6}disabled: true\n/)
    // The only difference is the inserted line: every other byte is the original.
    assert.equal(nextHome.replace('      disabled: true\n', ''), HOME)
    assert.match(nextHome, /# --- keep me: a hand-written block ---/)

    const nextProfile = readFileSync(profilePatch, 'utf8')
    assert.equal(nextProfile.slice(0, PROFILE.length), PROFILE)
    assert.match(nextProfile, /\n {6}- serverName: codegraph\n {8}transport: stdio\n/)

    // One per file written, with the documented name and the pre-edit bytes.
    const taken = backups()
    assert.equal(taken.length, 2)
    for (const name of taken) {
      assert.match(name, /^cordis\.patch\.yml\.bak-\d{8}-\d{6}-before-adopt$/)
    }
    assert.equal(readFileSync(join(sandbox, taken[0]!), 'utf8'), HOME)
    assert.equal(readFileSync(join(dirname(profilePatch), taken[1]!), 'utf8'), PROFILE)
  })

  it('is idempotent: a second run writes nothing and takes no new backup', () => {
    resetFixtures()
    assert.equal(adopt(['--dsh-home', sandbox, '--write'], { composed: true }).status, 0)
    const afterFirst = { home: digest(homePatch), profile: digest(profilePatch) }
    const taken = backups().length
    assert.equal(taken, 2)

    const second = adopt(['--dsh-home', sandbox, '--write'], { composed: true })
    assert.equal(second.status, 0)
    assert.match(second.stdout, /0 blocked/)
    assert.match(second.stdout, /0 server\(s\) to move, 0 row\(s\) to disable/)
    assert.doesNotMatch(second.stdout, /Wrote/)
    assert.equal(digest(homePatch), afterFirst.home)
    assert.equal(digest(profilePatch), afterFirst.profile)
    assert.equal(backups().length, taken)
  })

  it('disables a row whose server is already in servers', () => {
    // The half of the job an earlier design got wrong: "already lazy" skips the
    // adoption, never the disable.
    resetFixtures()
    writeFileSync(
      profilePatch,
      PROFILE.replace(
        '      - serverName: phonemcp\n',
        () => '      - serverName: codegraph\n        transport: stdio\n        command: codegraph\n      - serverName: phonemcp\n',
      ),
    )
    const dump = stubDump().replace(
      '      - serverName: phonemcp\n',
      () => '      - serverName: codegraph\n        transport: stdio\n        command: codegraph\n      - serverName: phonemcp\n',
    )
    writeFileSync(join(sandbox, 'stub-dump.yml'), dump)
    try {
      const result = adopt(['--dsh-home', sandbox, '--write'], { composed: true })
      assert.equal(result.status, 0)
      assert.match(result.stdout, /0 server\(s\) to move, 1 row\(s\) to disable/)
      assert.match(readFileSync(homePatch, 'utf8'), /disabled: true/)
    } finally {
      writeFileSync(join(sandbox, 'stub-dump.yml'), stubDump())
    }
  })
})

describe('adopt.mjs — error paths (AD11, AD15)', () => {
  it('exits 2 and writes nothing when the file does not exist', () => {
    resetFixtures()
    const before = digest(homePatch)
    const result = adopt(['--dsh-home', sandbox, '--file', join(sandbox, 'nope.yml'), '--write'])
    assert.equal(result.status, 2)
    assert.match(result.stderr, /cannot read/)
    assert.equal(digest(homePatch), before)
    assert.deepEqual(backups(), [])
  })

  it('records the digest of every file it is about to write (AD15)', () => {
    // The concurrency guard is a comparison against a digest taken when the plan
    // was built, so the digest has to be in the plan for the guard to mean
    // anything. This asserts the value reported is the file's real digest — that
    // is what makes "this changed underneath me" detectable at all.
    resetFixtures()
    const result = adopt(['--dsh-home', sandbox, '--json'], { composed: true })
    assert.equal(result.status, 0)
    const plan = JSON.parse(result.stdout)
    assert.deepEqual(Object.keys(plan.digests).sort(), [homePatch, profilePatch].sort())
    assert.equal(plan.digests[homePatch], digest(homePatch))
    assert.equal(plan.digests[profilePatch], digest(profilePatch))
  })

  it('exits 2 on an unknown flag', () => {
    const result = adopt(['--nonsense'])
    assert.equal(result.status, 2)
    assert.match(result.stderr, /unknown argument/)
  })

  it('exits 2 when a flag is missing its value', () => {
    const result = adopt(['--dsh-home'])
    assert.equal(result.status, 2)
    assert.match(result.stderr, /needs a value/)
  })

  it('exits 1 when a row is refused, and 0 with --allow-skip, writing nothing either way', () => {
    resetFixtures()
    // A row carrying a field this plugin does not implement is a real skip: the
    // server should have moved and did not.
    const withReconnect = HOME.replace(
      '        command: codegraph\n',
      () => '        command: codegraph\n        reconnect:\n          maxAttempts: 3\n',
    )
    writeFileSync(homePatch, withReconnect)
    writeFileSync(
      join(sandbox, 'stub-dump.yml'),
      stubDump().replace(
        '    command: codegraph\n',
        () => '    command: codegraph\n    reconnect:\n      maxAttempts: 3\n',
      ),
    )
    try {
      const refused = adopt(['--dsh-home', sandbox, '--write'], { composed: true })
      assert.equal(refused.status, 1)
      assert.match(refused.stdout, /unsupported-field/)
      // Nothing was written, so the row is still where it was.
      assert.equal(readFileSync(homePatch, 'utf8'), withReconnect)
      assert.deepEqual(backups(), [])

      const allowed = adopt(['--dsh-home', sandbox, '--write', '--allow-skip'], { composed: true })
      assert.equal(allowed.status, 0)
    } finally {
      writeFileSync(join(sandbox, 'stub-dump.yml'), stubDump())
    }
  })

  it('leaves every file alone when the second one cannot be written (AD11, B4)', () => {
    // The failure that matters is not "the write failed" but "the write failed
    // *halfway*". A disable applied to one file without the matching append in
    // the other removes a server from both plugins: it is neither configured
    // lazily nor registered natively, and nothing says so.
    //
    // The failure is injected at the rename — the last step, after the first
    // file has already been swapped in — because that is the state the rollback
    // exists for. Injecting earlier would only prove the plan is validated
    // before anything is written, which is a different (and cheaper) claim.
    resetFixtures()
    // Next to the real script, so its `../lib/...` imports resolve. Running a
    // copy from the fixture directory would only test a broken import.
    const injected = join(repo, 'scripts', 'adopt-injected.test.mjs')
    const source = readFileSync(script, 'utf8')
    const patched = source.replace(
      '      renameSync(entry.temporary, entry.file)',
      '      if (entry.file === process.env.INJECT_FAILURE_FOR) throw new Error("injected: rename refuses")\n' +
        '      renameSync(entry.temporary, entry.file)',
    )
    assert.notEqual(patched, source, 'the injection point moved; fix this test rather than deleting it')
    writeFileSync(injected, patched)

    const before = { home: digest(homePatch), profile: digest(profilePatch) }
    const result = spawnSync(
      process.execPath,
      [injected, '--dsh-home', sandbox, '--write'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${stubBin}:${process.env['PATH'] ?? ''}`,
          INJECT_FAILURE_FOR: profilePatch,
        },
      },
    )
    assert.equal(result.status, 2)
    assert.match(result.stderr, /injected: rename refuses/)
    assert.match(result.stderr, /restored/)
    // Both files are back to their original bytes, and no half-written temp file
    // was left behind.
    assert.equal(digest(homePatch), before.home)
    assert.equal(digest(profilePatch), before.profile)
    assert.deepEqual(
      readdirSync(dirname(profilePatch)).filter(name => name.includes('.tmp')),
      [],
    )
    rmSync(injected, { force: true })
  })

  it('prints usage on --help', () => {
    const result = adopt(['--help'])
    assert.equal(result.status, 0)
    assert.match(result.stdout, /--allow-skip/)
  })

  it('runs when invoked through a symlink, the way a `bin` entry is (AD10)', () => {
    // `npm install` and `pnpm add` expose `bin` as a *symlink* on POSIX, so
    // `argv[1]` is the link and `import.meta.url` is the real file. Comparing the
    // two without resolving symlinks makes the entry point undetectable: the CLI
    // then prints nothing and exits 0, which looks like "nothing to do" rather
    // than like a broken installation — the worst possible failure for a command
    // whose whole job is reporting what it would change.
    const link = join(sandbox, 'dsh-mcp-lazy-adopt')
    symlinkSync(script, link)
    // Run it *through* `node` rather than executing the link directly. Executing
    // it makes the kernel read the shebang and resolve `/usr/bin/env`, which a
    // container without an executable `/tmp` cannot do — the test then fails with
    // "Cannot find module" for a reason that has nothing to do with the entry
    // check it exists to cover.
    const result = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8' })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /Usage:/)
    assert.match(result.stdout, /--allow-skip/)
  })
})
