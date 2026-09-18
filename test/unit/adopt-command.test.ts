/**
 * The `/mcp-adopt` human command.
 *
 * The CLI next door (`adopt.mjs`) owns the plan and the write; this suite owns
 * what only exists once a *human* can trigger it:
 *
 * 1. **The gateway never waits for the command registry.** The command is reached
 *    through an optional injection, because `inject: ['tools','commands']` would
 *    leave the whole MCP gateway inactive on a composition without a command
 *    registry — the worst possible regression for this plugin. The first block
 *    runs against a **real cordis context** rather than a hand-rolled double,
 *    because that is the only way the claim is actually exercised.
 * 2. **The default is a dry run, and the write is not cancellable.** A bare
 *    `/mcp-adopt` reaches the CLI without `--write`; only `apply` passes it. A
 *    cancelled dry run costs nothing, but a cancelled *write* can stop between
 *    the CLI's two renames.
 * 3. **Exit codes are translated, not passed through.** Exit 1 means "some rows
 *    were skipped" and the CLI has already written by then, so reporting it as an
 *    error would say nothing happened when something did.
 * 4. **Neither side guesses.** The profile and home come from `ctx.baseUrl`, are
 *    passed explicitly, and an underivable pair refuses instead of defaulting.
 *
 * The last blocks run the **real** shipped script through the command's default
 * runner against a sandbox home with a stub `dsh`.
 */

import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { tempDir } from '../helpers/tmp.ts'
import { apply as applyPlugin, PROXY_TOOL_NAME } from '../../lib/index.js'
import { ADOPT_COMMAND_NAME, registerAdoptCommand } from '../../lib/command.js'
import type {
  AdoptRun,
  CommandDefinitionLike,
  CommandResult,
  HostProfile,
} from '../../lib/command.js'

/** The profile every unit test pretends to run in. */
const WEB: HostProfile = { home: '/home/tester/.dsh', name: 'web' }

/** The base arguments a resolved profile produces, without `--write`. */
const BASE = ['--profile', 'web', '--dsh-home', '/home/tester/.dsh']

const OK: AdoptRun = { status: 0, stdout: 'plan text\n', stderr: '' }

// ---------------------------------------------------------------------------
// A host that only has what the command is allowed to touch
// ---------------------------------------------------------------------------

interface FakeRegistry {
  commands: { register: (definition: CommandDefinitionLike) => () => void }
}

function fakeHost(baseUrl?: string): {
  ctx: unknown
  injections: { deps: readonly string[]; activate: (registry: FakeRegistry) => void }[]
  registered: CommandDefinitionLike[]
  deliver: () => FakeRegistry
  teardown: () => void
} {
  const injections: { deps: readonly string[]; activate: (registry: FakeRegistry) => void }[] = []
  const registered: CommandDefinitionLike[] = []
  const disposers: (() => void)[] = []
  const ctx = {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    inject(deps: readonly string[], callback: (child: FakeRegistry) => void): unknown {
      injections.push({ deps, activate: callback as (registry: FakeRegistry) => void })
      return {}
    },
  }
  const registry: FakeRegistry = {
    commands: {
      register(definition) {
        registered.push(definition)
        const disposer = (): void => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
        disposers.push(disposer)
        return disposer
      },
    },
  }
  return {
    ctx,
    injections,
    registered,
    deliver: () => {
      const pending = injections.at(-1)
      assert.ok(pending !== undefined, 'the command never asked for the commands service')
      pending.activate(registry)
      return registry
    },
    teardown: () => {
      for (const disposer of disposers.splice(0)) disposer()
    },
  }
}

/**
 * A runner that records its calls and answers with a scripted sequence.
 *
 * One outcome is repeated for every call; a list is consumed in order. The
 * distinction matters, because `apply` calls the CLI twice — once to write, once
 * to re-plan — and a test that conflated them would not notice.
 */
function scriptedRun(outcomes: AdoptRun | Error | (AdoptRun | Error)[]): {
  run: (args: readonly string[], signal?: AbortSignal) => Promise<AdoptRun>
  calls: string[][]
  signals: (AbortSignal | undefined)[]
} {
  const queue = Array.isArray(outcomes) ? [...outcomes] : undefined
  const calls: string[][] = []
  const signals: (AbortSignal | undefined)[] = []
  return {
    calls,
    signals,
    run: async (args, signal) => {
      calls.push([...args])
      signals.push(signal)
      const next = queue === undefined ? (outcomes as AdoptRun | Error) : queue.shift()
      if (next === undefined) throw new Error('the runner was called more times than the script provides')
      if (next instanceof Error) throw next
      return next
    },
  }
}

/** Register the command and hand back its definition. */
function command(
  deps: Parameters<typeof registerAdoptCommand>[1],
  options: { baseUrl?: string; realProfile?: boolean } = {},
): { definition: CommandDefinitionLike; host: ReturnType<typeof fakeHost> } {
  const host = fakeHost(options.baseUrl)
  // The profile seam is stubbed by default so a test can assert the arguments a
  // resolved profile produces; the resolver itself is exercised by the tests
  // that opt out with `realProfile`.
  const seams = options.realProfile === true ? deps : { profile: () => WEB, ...deps }
  registerAdoptCommand(host.ctx as never, seams)
  host.deliver()
  const definition = host.registered.at(0)
  assert.ok(definition !== undefined, 'no command was registered')
  return { definition, host }
}

/** Invoke the handler with a raw input line. */
function invoke(
  definition: CommandDefinitionLike,
  rawInput: string,
  signal?: AbortSignal,
): Promise<CommandResult> {
  // Only the two fields the command reads: a real invocation carries `attachments`
  // and more, and it stays assignable to the wider shape precisely because this
  // one is narrower.
  return Promise.resolve(
    definition.handler({
      rawInput,
      signal: signal ?? new AbortController().signal,
    }) as CommandResult | Promise<CommandResult>,
  )
}

/** Let cordis settle one turn of service activation. */
function settle(): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, 0)
  })
}

// ---------------------------------------------------------------------------
// Registration, against a real cordis context
// ---------------------------------------------------------------------------

describe('the gateway never waits for the command registry', () => {
  it('registers the tool with no registry, then the command when it appears', async () => {
    const ctx = new Context()
    const tools: string[] = []
    const commands: string[] = []
    ctx.provide('tools', {
      register: (definition: { name: string }) => {
        tools.push(definition.name)
        return () => {
          const index = tools.indexOf(definition.name)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    })

    applyPlugin(ctx as never, { idleTimeout: 10, servers: [] } as never)
    // The whole point: no command registry exists yet, and the gateway is live.
    assert.deepEqual(tools, [PROXY_TOOL_NAME])

    ctx.provide('commands', {
      register: (definition: { name: string }) => {
        commands.push(definition.name)
        return () => {
          const index = commands.indexOf(definition.name)
          if (index >= 0) commands.splice(index, 1)
        }
      },
    })
    await settle()
    assert.deepEqual(commands, [ADOPT_COMMAND_NAME])

    // Teardown only has to be clean here. That a registration genuinely rides the
    // calling fiber is upstream's behaviour — `CommandRuntime.register` is
    // `this.layers.effect(this.ctx, ...)`, where `this.ctx` resolves to the
    // caller — and a hand-written registry cannot reproduce it, so asserting it
    // against this double would be asserting the double.
    await ctx.fiber.dispose()
  })

  it('asks for the commands service, and reads it only from the injected scope', () => {
    const host = fakeHost()
    registerAdoptCommand(host.ctx as never, { run: scriptedRun(OK).run })
    host.deliver()

    assert.equal(host.injections.length, 1, 'expected exactly one optional injection')
    assert.deepEqual(host.injections[0]?.deps, ['commands'])
    assert.equal(host.registered.length, 1, 'one command, not one per call')
    // The regression this pins: reading `ctx.commands` directly would work on a
    // rich host and be undefined on a lean one, so the plugin would depend on
    // something its `inject` list does not promise.
    assert.ok(
      !Object.prototype.hasOwnProperty.call(host.ctx as object, 'commands'),
      'the plugin must not reach for the registry outside the injected scope',
    )

    host.teardown()
    assert.equal(host.registered.length, 0)
  })

  it('names itself and advertises its input', () => {
    const { definition } = command({ run: scriptedRun(OK).run })

    assert.equal(definition.name, 'mcp-adopt')
    assert.ok(definition.description.length > 0, 'a command without a description is undiscoverable')
    assert.equal(typeof definition.input?.hint, 'string')
  })
})

// ---------------------------------------------------------------------------
// The input grammar
// ---------------------------------------------------------------------------

describe('the input grammar refuses to guess', () => {
  it('treats no input as a dry run, and never passes --write', async () => {
    const runner = scriptedRun(OK)
    const { definition } = command({ run: runner.run })

    const result = await invoke(definition, '')

    assert.equal(result.kind, 'success')
    assert.deepEqual(runner.calls, [BASE])
  })

  it('treats whitespace as no input', async () => {
    const runner = scriptedRun(OK)
    const { definition } = command({ run: runner.run })

    await invoke(definition, '   \n ')

    assert.deepEqual(runner.calls, [BASE])
  })

  it('writes only on an explicit apply, case-insensitively', async () => {
    const runner = scriptedRun([{ ...OK, stdout: 'wrote\n' }, OK])
    const { definition } = command({ run: runner.run })

    const result = await invoke(definition, '  APPLY  ')

    assert.equal(result.kind, 'success')
    assert.deepEqual(runner.calls[0], [...BASE, '--write'])
  })

  it('refuses an unknown verb without spawning anything', async () => {
    const runner = scriptedRun(OK)
    const { definition } = command({ run: runner.run })

    const result = await invoke(definition, 'apply --force')

    assert.equal(result.kind, 'error')
    assert.match(result.kind === 'error' ? result.text : '', /apply/i)
    assert.deepEqual(runner.calls, [], 'a refused input must not reach the CLI')
  })
})

// ---------------------------------------------------------------------------
// Cancellation and evidence
// ---------------------------------------------------------------------------

describe('cancellation and evidence', () => {
  it('forwards the cancellation signal to a dry run', async () => {
    const runner = scriptedRun(OK)
    const { definition } = command({ run: runner.run })
    const controller = new AbortController()

    await invoke(definition, '', controller.signal)

    assert.equal(runner.signals[0], controller.signal)
  })

  it('withholds the signal from a write, which cannot be stopped halfway', async () => {
    const runner = scriptedRun([{ ...OK, stdout: 'wrote\n' }, OK])
    const { definition } = command({ run: runner.run })
    const controller = new AbortController()

    await invoke(definition, 'apply', controller.signal)

    assert.equal(
      runner.signals[0],
      undefined,
      'the CLI writes two files in sequence; a kill between them leaves half a move',
    )
  })

  it('re-plans after a write so the result carries evidence', async () => {
    const wrote = 'Wrote 2 file(s).\n'
    const recheck = '0 server(s) to move, 0 row(s) to disable, 1 row(s) needing no action, 0 blocked\n'
    const runner = scriptedRun([
      { status: 0, stdout: wrote, stderr: '' },
      { status: 0, stdout: recheck, stderr: '' },
    ])
    const { definition } = command({ run: runner.run })

    const result = await invoke(definition, 'apply')
    const text = result.kind === 'success' ? (result.text ?? '') : ''

    assert.deepEqual(runner.calls, [[...BASE, '--write'], BASE])
    assert.match(text, /Wrote 2 file\(s\)/)
    assert.match(text, /Confirmed by re-planning: 0 server\(s\) to move/)
  })

  it('says so when the re-plan still reports work', async () => {
    const runner = scriptedRun([
      { status: 0, stdout: 'Wrote 1 file(s).\n', stderr: '' },
      { status: 0, stdout: '1 server(s) to move, 1 row(s) to disable, 0 blocked\n', stderr: '' },
    ])
    const { definition } = command({ run: runner.run })

    const result = await invoke(definition, 'apply')

    assert.match(result.kind === 'success' ? (result.text ?? '') : '', /⚠ Re-planning still reports work/)
  })

  it('does not re-plan a dry run', async () => {
    const runner = scriptedRun(OK)
    const { definition } = command({ run: runner.run })

    await invoke(definition, '')

    assert.equal(runner.calls.length, 1)
  })
})

// ---------------------------------------------------------------------------
// Exit-code translation
// ---------------------------------------------------------------------------

describe('exit codes are translated rather than passed through', () => {
  it('reports success and the CLI text verbatim on exit 0', async () => {
    const stdout = 'adopt   codegraph\n\nDry run. Nothing was written.\n'
    const { definition } = command({ run: scriptedRun({ status: 0, stdout, stderr: '' }).run })

    const result = await invoke(definition, '')

    assert.equal(result.kind, 'success')
    assert.equal(result.kind === 'success' ? result.text : '', stdout)
  })

  it('reports a partial move as success, because the write already happened', async () => {
    const stdout = '1 server(s) to move, 1 row(s) to disable, 1 blocked\n'
    const { definition } = command({
      run: scriptedRun({ status: 1, stdout, stderr: 'adopt: 1 row(s) should have moved\n' }).run,
    })

    const result = await invoke(definition, 'apply')

    assert.equal(result.kind, 'success', 'exit 1 happens after the write, so it is not a failure')
    const text = result.kind === 'success' ? (result.text ?? '') : ''
    assert.match(text, /skip/i)
    assert.ok(text.includes(stdout), 'the CLI output has to survive the translation')
  })

  it('reports an environment error as an error, carrying the CLI message', async () => {
    const { definition } = command({
      run: scriptedRun({
        status: 2,
        stdout: '',
        stderr: 'adopt: dsh --profile web --dump-config exited 1\n',
      }).run,
    })

    const result = await invoke(definition, '')

    assert.equal(result.kind, 'error')
    assert.match(result.kind === 'error' ? result.text : '', /dump-config exited 1/)
  })

  it('reports a signalled death as an error', async () => {
    const { definition } = command({ run: scriptedRun({ status: null, stdout: '', stderr: '' }).run })

    assert.equal((await invoke(definition, '')).kind, 'error')
  })
})

// ---------------------------------------------------------------------------
// Failure containment
// ---------------------------------------------------------------------------

describe('no failure escapes the handler', () => {
  it('reports a runner that throws instead of rejecting', async () => {
    const { definition } = command({
      run: scriptedRun(Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })).run,
    })

    const result = await invoke(definition, '')

    assert.equal(result.kind, 'error')
    assert.match(result.kind === 'error' ? result.text : '', /EACCES/)
  })

  it('reports a runner that could not start the process at all', async () => {
    const { definition } = command({
      run: scriptedRun({ status: null, stdout: '', stderr: '', failure: 'spawn ENOENT' }).run,
    })

    const result = await invoke(definition, '')

    assert.equal(result.kind, 'error')
    assert.match(result.kind === 'error' ? result.text : '', /ENOENT/)
  })

  it('refuses to guess a profile it cannot derive', async () => {
    const runner = scriptedRun(OK)
    const host = fakeHost()
    // No `profile` seam: this exercises the real resolver, with no base URL at all.
    registerAdoptCommand(host.ctx as never, { run: runner.run })
    host.deliver()
    const definition = host.registered.at(0) as CommandDefinitionLike

    const result = await invoke(definition, '')

    assert.equal(result.kind, 'error', "writing another profile's config is unrecoverable")
    assert.deepEqual(runner.calls, [])
  })

  it('refuses a base URL that is not <home>/profiles/<name>', async () => {
    const runner = scriptedRun(OK)
    const { definition } = command(
      { run: runner.run },
      { baseUrl: pathToFileURL('/home/tester/.dsh/').href, realProfile: true },
    )

    const result = await invoke(definition, '')

    assert.equal(result.kind, 'error')
    assert.deepEqual(runner.calls, [])
  })

  it('derives both halves of the profile from the base URL', async () => {
    const home = tempDir('dsh-mcp-lazy-profile-')
    const profileDir = join(home, 'profiles', 'nightly')
    mkdirSync(profileDir, { recursive: true })
    const runner = scriptedRun(OK)
    const { definition } = command(
      { run: runner.run },
      { baseUrl: pathToFileURL(`${profileDir}/`).href, realProfile: true },
    )

    await invoke(definition, '')

    assert.deepEqual(runner.calls, [['--profile', 'nightly', '--dsh-home', home]])
  })

  it('gives up on a runner that never answers', async () => {
    const { definition } = command({
      timeoutMs: 40,
      run: () => new Promise<AdoptRun>(() => {}),
    })

    const result = await invoke(definition, '')

    assert.equal(result.kind, 'error')
    assert.match(result.kind === 'error' ? result.text : '', /did not finish within 40ms/)
  })
})

// ---------------------------------------------------------------------------
// The real script, through the default runner
// ---------------------------------------------------------------------------

/** A home layer with one managed native row and an unrelated hand-written block. */
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
].join('\n')

/** The profile layer carrying this plugin's own config. */
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

describe('the default runner reaches the real shipped script', () => {
  let sandbox = ''
  let homePatch = ''
  let profilePatch = ''
  let originalPath = ''

  function reset(): void {
    for (const directory of [sandbox, join(sandbox, 'profiles', 'web')]) {
      for (const name of readdirSync(directory)) {
        if (name.includes('before-adopt')) rmSync(join(directory, name), { force: true })
      }
    }
    writeFileSync(homePatch, HOME)
    writeFileSync(profilePatch, PROFILE)
  }

  /**
   * The composed dump the stub `dsh` prints.
   *
   * Regenerated from the patch files on every call. The command re-plans after a
   * write to show the user what the file now says, so a frozen dump would report
   * the pre-write state and that verification would look like it had failed —
   * for a reason that has nothing to do with the code under test.
   *
   * @returns The source of a small generator the stub runs.
   */
  function stubGenerator(): string {
    const nativeRowHead = [
      '# == @deepseek-ai/dsh-base',
      '- id: webserver',
      "  name: '@deepseek-ai/dsh-webserver'",
      `# == ${homePatch}`,
      '- id: mcp-codegraph-managed',
      "  name: '@deepseek-ai/dsh-mcp-client'",
    ]
    const gatewayRow = [
      `# == dsh-mcp-lazy, patched by ${profilePatch}`,
      '- id: mcp-lazy',
      '  config:',
      '    idleTimeout: 10',
      '    servers:',
      '      - serverName: phonemcp',
      '        transport: stdio',
      '        command: /usr/bin/python',
    ]
    return [
      "import { readFileSync } from 'node:fs'",
      `const home = ${JSON.stringify(homePatch)}`,
      "const disabled = /^ {6}disabled: true$/mu.test(readFileSync(home, 'utf8'))",
      `const head = ${JSON.stringify(nativeRowHead)}`,
      `const tail = ${JSON.stringify(gatewayRow)}`,
      "const row = [",
      "  '  config:',",
      "  '    serverName: codegraph',",
      "  '    transport: stdio',",
      "  '    command: codegraph',",
      "  '    args:',",
      "  '      - serve',",
      '  "      - \'--mcp\'",',
      ']',
      // The dump is the flattened top-level list, so a row's own keys sit at two
      // spaces — not the six they carry inside the patch file's `- insert:` item.
      "const disabledLine = disabled ? ['  disabled: true'] : []",
      "process.stdout.write([...head, ...disabledLine, ...row, ...tail, ''].join('\\n') + '\\n')",
    ].join('\n')
  }

  function digest(file: string): string {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  }

  /** A definition wired to the real script and the sandbox's own profile. */
  function realCommand(): CommandDefinitionLike {
    const host = fakeHost(pathToFileURL(`${join(sandbox, 'profiles', 'web')}/`).href)
    registerAdoptCommand(host.ctx as never, {})
    host.deliver()
    return host.registered.at(0) as CommandDefinitionLike
  }

  before(() => {
    sandbox = tempDir('dsh-mcp-lazy-command-')
    homePatch = join(sandbox, 'cordis.patch.yml')
    profilePatch = join(sandbox, 'profiles', 'web', 'cordis.patch.yml')
    mkdirSync(dirname(profilePatch), { recursive: true })

    // A `dsh` that answers only `--dump-config`, and reads the patch files so the
    // dump tracks what the command just wrote. Anything other than `--dump-config`
    // is a failure the test wants to see rather than a silent pass.
    const stubBin = join(sandbox, 'bin')
    mkdirSync(stubBin)
    const generator = join(sandbox, 'stub-dump.mjs')
    writeFileSync(generator, stubGenerator())
    writeFileSync(
      join(stubBin, 'dsh'),
      `#!/bin/sh\nif [ "$3" != "--dump-config" ]; then echo "stub dsh: unexpected args: $@" >&2; exit 9; fi\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(generator)}\n`,
    )
    chmodSync(join(stubBin, 'dsh'), 0o755)

    originalPath = process.env['PATH'] ?? ''
    process.env['PATH'] = `${stubBin}:${originalPath}`
    reset()
  })

  after(() => {
    process.env['PATH'] = originalPath
  })

  it('leaves both patch files byte-identical on a bare invocation', async () => {
    reset()
    const before = { home: digest(homePatch), profile: digest(profilePatch) }

    const result = await invoke(realCommand(), '')

    assert.equal(result.kind, 'success')
    assert.match(result.kind === 'success' ? (result.text ?? '') : '', /Dry run/)
    assert.equal(digest(homePatch), before.home)
    assert.equal(digest(profilePatch), before.profile)
  })

  it('moves the row, disables it in place, and reports the re-plan', async () => {
    reset()

    const result = await invoke(realCommand(), 'apply')
    const text = result.kind === 'success' ? (result.text ?? '') : ''

    assert.equal(result.kind, 'success')
    assert.match(readFileSync(homePatch, 'utf8'), /^ {6}disabled: true$/m)
    assert.match(readFileSync(profilePatch, 'utf8'), /serverName: codegraph/)
    assert.match(readFileSync(profilePatch, 'utf8'), /# Your patch layer for this dsh profile\./)
    assert.match(text, /Confirmed by re-planning: 0 server\(s\) to move/)
  })

  it('warns when the disabled row would take the server from other profiles', async () => {
    reset()
    // A second profile that reads the same home layer but does not mount this
    // plugin: it would lose codegraph outright, and nothing else would say so.
    const other = join(sandbox, 'profiles', 'headless')
    mkdirSync(other, { recursive: true })
    writeFileSync(
      join(other, 'package.json'),
      JSON.stringify({ name: 'dsh-profile-headless', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
    )
    const mine = join(sandbox, 'profiles', 'web', 'package.json')
    writeFileSync(
      mine,
      JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-mcp-lazy'] } } }),
    )

    const result = await invoke(realCommand(), '')
    const text = result.kind === 'success' ? (result.text ?? '') : ''

    assert.match(text, /⚠ the row being disabled lives in the home layer/)
    assert.match(text, /would lose codegraph with no replacement: headless/)
    assert.doesNotMatch(text, /web(,|\.)/, 'the profile that mounts the plugin is not at risk')
  })
})
