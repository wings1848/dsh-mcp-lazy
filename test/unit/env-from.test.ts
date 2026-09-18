/**
 * `envFrom`: a server's secrets, resolved by running a command at spawn time.
 *
 * Every assertion here is about something observable rather than inferred:
 * a value that did or did not reach the child's environment (the fixture's
 * `dump_env`), an argument that did or did not reach its argv (`dump_argv`),
 * a process that did or did not survive a timeout, and bytes that did or did
 * not land on disk.
 *
 * The two properties that decide whether this feature is safe to use are
 * "a failure is never a silent empty value" and "the value ends up nowhere
 * except the child". Most of what follows tests one of those two.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { tempDir } from '../helpers/tmp.ts'
import { LazyConnections } from '../../lib/connection.js'
import { apply } from '../../lib/index.js'
import { computeConfigHash } from '../../lib/metadata-cache.js'
import { qualifiedToolName } from '../../lib/naming.js'
import { McpGatewayRegistry } from '../../lib/registry.js'
import type { Config, ServerEntry, ToolCallResult } from '../../lib/types.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, '..', 'fixtures', 'mcp-server.mjs')
const originalHome = process.env['DSH_HOME']

/** A value that is recognisable anywhere it turns up. */
const SENTINEL = 'SENTINEL-9f3a2b7c1d4e'

let workdir: string

const layers: LazyConnections[] = []

before(() => {
  workdir = tempDir('dsh-mcp-lazy-envfrom-')
  process.env['DSH_HOME'] = join(workdir, 'home')
})

after(async () => {
  await Promise.all(layers.map(layer => layer.dispose().catch(() => undefined)))
  if (originalHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = originalHome
})

/**
 * Build a stdio entry pointed at the fixture.
 *
 * @param serverName - Namespace for the server.
 * @param overrides - Entry overrides, including `envFrom`.
 * @returns The entry.
 */
function fixtureServer(serverName: string, overrides: Partial<ServerEntry> = {}): ServerEntry {
  return {
    serverName,
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    env: {
      FIXTURE_START_COUNT: join(workdir, `${serverName}.starts`),
      FIXTURE_PID_FILE: join(workdir, `${serverName}.pid`),
    },
    toolCallTimeoutMs: 5000,
    ...overrides,
  }
}

/** A registry wired to a real lazy connection layer. */
function gateway(
  entries: ServerEntry[],
  extra: Partial<Config> = {},
): { registry: McpGatewayRegistry; connections: LazyConnections } {
  const connections = new LazyConnections(() => 600_000, { startSweeper: false })
  layers.push(connections)
  connections.setQualifier(qualifiedToolName)
  const config: Config = { idleTimeout: 10, servers: entries, ...extra }
  const registry = new McpGatewayRegistry(config, connections)
  registry.bindLiveCatalogRefresh()
  return { registry, connections }
}

/** Call one tool through the registry, awaiting the connection. */
async function call(
  registry: McpGatewayRegistry,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<ToolCallResult> {
  const { resolution } = await registry.discoverAndResolve(tool, undefined, undefined)
  assert.equal(resolution.kind, 'ok', `expected to resolve ${tool}, got ${resolution.kind}`)
  if (resolution.kind !== 'ok') throw new Error('unreachable')
  return registry.invoke(resolution.target, args, undefined)
}

/** Flatten a tool result into text. */
function textOf(result: ToolCallResult): string {
  return result.blocks.map(block => (block.type === 'text' ? block.text : '')).join('\n')
}

/** Ask a connected fixture what it sees for the given names. */
async function dumpEnv(registry: McpGatewayRegistry, names: string[]): Promise<string> {
  return textOf(await call(registry, 'dump_env', { names }))
}

/**
 * Whether a pid is gone.
 *
 * `close()` is asynchronous, so a just-killed child is briefly a zombie and
 * signal 0 still succeeds against one; polling keeps the test fast when the
 * process died promptly and honest when it did not.
 *
 * @param pid - The process to watch.
 * @param timeoutMs - How long to wait before concluding it is still alive.
 * @returns True once the process is gone.
 */
async function processExits(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

/** Read a pid a shell command recorded, or 0 when it never got there. */
function recordedPid(file: string): number {
  try {
    return Number.parseInt(readFileSync(file, 'utf8').trim(), 10) || 0
  } catch {
    return 0
  }
}

/** Every file under a directory, recursively. */
function filesUnder(root: string): string[] {
  const found: string[] = []
  const walk = (path: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(path)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(path, entry)
      if (statSync(full).isDirectory()) walk(full)
      else found.push(full)
    }
  }
  walk(root)
  return found
}

/** A context with only the members `apply` is allowed to touch. */
function fakeContext(): { ctx: unknown; registered: ToolDefinition[] } {
  const registered: ToolDefinition[] = []
  const ctx = {
    tools: {
      register: (definition: ToolDefinition): (() => void) => {
        registered.push(definition)
        return () => undefined
      },
    },
    effect: (): void => undefined,
    inject: (): unknown => undefined,
  }
  return { ctx, registered }
}

describe('envFrom — the value reaches the child', () => {
  it('AC1: resolves the command and injects its trimmed stdout', async () => {
    const entry = fixtureServer('resolved', {
      envFrom: { PROBE: 'printf "real-value\\n"' },
    })
    const { registry } = gateway([entry])

    const text = await dumpEnv(registry, ['PROBE'])
    assert.match(text, /PROBE=real-value/, text)
    await registry.dispose()
  })

  it('AC1b: runs the command through a shell, so pipes work', async () => {
    const entry = fixtureServer('piped', {
      envFrom: { PROBE: 'printf "a-b-c" | tr "-" "_"' },
    })
    const { registry } = gateway([entry])

    const text = await dumpEnv(registry, ['PROBE'])
    assert.match(text, /PROBE=a_b_c/, text)
    await registry.dispose()
  })

  it('AC11: the command does not inherit the host credential-shaped environment', async () => {
    process.env['MY_SERVICE_TOKEN'] = 'leaked-token'
    const entry = fixtureServer('scrubbed', {
      envFrom: { PROBE: 'printf "%s" "${MY_SERVICE_TOKEN:-none}"' },
    })
    const { registry } = gateway([entry])

    const text = await dumpEnv(registry, ['PROBE'])
    assert.match(text, /PROBE=none/, text)
    delete process.env['MY_SERVICE_TOKEN']
    await registry.dispose()
  })

  it('AC12: the command does not inherit the entry\'s own env block', async () => {
    const entry = fixtureServer('no-env-bleed', {
      env: { FIXTURE_MARKER: 'entry-only' },
      envFrom: { PROBE: 'printf "%s" "${FIXTURE_MARKER:-none}"' },
    })
    const { registry } = gateway([entry])

    const text = await dumpEnv(registry, ['PROBE'])
    assert.match(text, /PROBE=none/, text)
    await registry.dispose()
  })

  it('AC4b: several variables resolve together', async () => {
    const entry = fixtureServer('multi', {
      envFrom: { PROBE_ONE: 'printf one', PROBE_TWO: 'printf two' },
    })
    const { registry } = gateway([entry])

    const text = await dumpEnv(registry, ['PROBE_ONE', 'PROBE_TWO'])
    assert.match(text, /PROBE_ONE=one/, text)
    assert.match(text, /PROBE_TWO=two/, text)
    await registry.dispose()
  })
})

describe('envFrom — args interpolation', () => {
  it('AC5: replaces {{NAME}} in args with the resolved value', async () => {
    const entry = fixtureServer('argv', {
      args: [FIXTURE, '--header=Bearer {{PROBE}}'],
      envFrom: { PROBE: 'printf tok-123' },
    })
    const { registry } = gateway([entry])

    const text = textOf(await call(registry, 'dump_argv'))
    assert.match(text, /--header=Bearer tok-123/, text)
    await registry.dispose()
  })

  it('AC5b: leaves an undeclared placeholder exactly as written', async () => {
    const entry = fixtureServer('argv-undeclared', {
      args: [FIXTURE, '--json={"a":"{{NOT_DECLARED}}"}'],
      envFrom: { PROBE: 'printf tok-123' },
    })
    const { registry } = gateway([entry])

    const text = textOf(await call(registry, 'dump_argv'))
    assert.match(text, /--json=\{"a":"\{\{NOT_DECLARED\}\}"\}/, text)
    await registry.dispose()
  })

  it('AC5c: substitutes a declared name that is not a POSIX identifier', async () => {
    // `envFrom` keys are arbitrary strings as far as the schema goes, so a
    // placeholder that only matched identifiers would silently do nothing for
    // a declared name like this one.
    const entry = fixtureServer('argv-dashed', {
      args: [FIXTURE, '--h={{api-key}}'],
      envFrom: { 'api-key': 'printf tok-456' },
    })
    const { registry } = gateway([entry])

    const text = textOf(await call(registry, 'dump_argv'))
    assert.match(text, /--h=tok-456/, text)
    await registry.dispose()
  })
})

describe('envFrom — failure is never a silent empty value', () => {
  it('AC2: a non-zero exit fails the start, naming the variable and the code', async () => {
    const entry = fixtureServer('exit-code', {
      envFrom: { PROBE: 'echo boom >&2; exit 3' },
    })
    const { connections } = gateway([entry])

    await assert.rejects(
      () => connections.connect(entry),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, /PROBE/, message)
        assert.match(message, /3/, message)
        assert.match(message, /boom/, message)
        return true
      },
    )
  })

  it('AC2b: the failure text carries stderr but never stdout', async () => {
    const entry = fixtureServer('no-stdout-leak', {
      envFrom: { PROBE: `printf ${SENTINEL}; echo boom >&2; exit 4` },
    })
    const { connections } = gateway([entry])

    await assert.rejects(
      () => connections.connect(entry),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.ok(!message.includes(SENTINEL), `stdout leaked into the error: ${message}`)
        return true
      },
    )
  })

  it('AC3: a timeout fails within its budget and leaves no process behind', async () => {
    const pidFile = join(workdir, 'timeout.pid')
    const entry = fixtureServer('timeout', {
      envFrom: { PROBE: `echo $$ > ${pidFile}; sleep 60` },
      envFromTimeoutMs: 300,
    })
    const { connections } = gateway([entry])

    const started = Date.now()
    await assert.rejects(
      () => connections.connect(entry),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, /PROBE/, message)
        assert.match(message, /300/, message)
        return true
      },
    )
    assert.ok(Date.now() - started < 10_000, 'the timeout must be enforced, not merely observed')

    const pid = recordedPid(pidFile)
    assert.notEqual(pid, 0, 'the command should have recorded its pid before sleeping')
    assert.equal(await processExits(pid), true, `pid ${pid} survived the timeout`)
  })

  it('AC4: empty output fails, and allowEmpty is the only way past it', async () => {
    const failing = fixtureServer('empty', { envFrom: { PROBE: 'printf ""' } })
    const first = gateway([failing])
    await assert.rejects(
      () => first.connections.connect(failing),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, /PROBE/, message)
        assert.match(message, /allowEmpty/, message)
        return true
      },
    )

    const allowed = fixtureServer('empty-allowed', {
      envFrom: { PROBE: 'printf ""' },
      allowEmpty: ['PROBE'],
    })
    const { registry } = gateway([allowed])
    const text = await dumpEnv(registry, ['PROBE'])
    assert.match(text, /PROBE=\n|PROBE=$/m, text)
    await registry.dispose()
  })

  it('AC2c: stderr is capped even when one chunk carries far more than the cap', async () => {
    // 300 KB in a single write. The cap has to be applied to what is kept, not
    // decided from the length *before* appending: a 64 KiB pipe chunk then
    // walks straight past a 2 KB limit.
    const entry = fixtureServer('big-stderr', {
      envFrom: { PROBE: "head -c 300000 /dev/zero | tr '\\0' 'x' >&2; exit 5" },
    })
    const { connections } = gateway([entry])

    await assert.rejects(
      () => connections.connect(entry),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.ok(
          message.length < 4_000,
          `the diagnostic must stay bounded, got ${message.length} characters`,
        )
        assert.match(message, /PROBE/, message)
        return true
      },
    )
  })

  it('AC2d: a value carrying a NUL byte is refused before spawn can quote it', async () => {
    const entry = fixtureServer('nul-byte', {
      envFrom: { PROBE: `printf 'LEAKME-1234\\000suffix'` },
    })
    const { registry, connections } = gateway([entry])

    await assert.rejects(
      () => connections.connect(entry),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, /PROBE/, message)
        assert.ok(!message.includes('LEAKME-1234'), `the value leaked into the error: ${message}`)
        return true
      },
    )
    // The same string is what `mcp({})` reports as `lastError`, so it must not
    // be reachable through the status surface either.
    const status = JSON.stringify(registry.status())
    assert.ok(!status.includes('LEAKME-1234'), 'the value leaked into registry status')
  })

  it('AC2e: stdout past the cap fails instead of silently truncating a secret', async () => {
    const entry = fixtureServer('big-stdout', {
      envFrom: { PROBE: "head -c 200000 /dev/zero | tr '\\0' 'y'" },
    })
    const { connections } = gateway([entry])

    await assert.rejects(
      () => connections.connect(entry),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, /PROBE/, message)
        assert.ok(!message.includes('yyyy'), `the value leaked into the error: ${message}`)
        return true
      },
    )
  })

  it('AC3b: a command that ignores SIGTERM is still killed, with nothing left behind', async () => {
    const pidFile = join(workdir, 'stubborn.pid')
    // A *fresh shell* backgrounds the stubborn member, so `$$` is that member's
    // own pid rather than the leader's — which is what makes "did it survive"
    // observable at all. Its stdio is redirected, so the leader's `close`
    // arrives first, and killing only the leader (or cancelling the escalation
    // when it does) would leave this member running for good.
    const bg = `sh -c 'echo $$ > ${pidFile}; trap "" TERM; sleep 60'`
    const member = `${bg} </dev/null >/dev/null 2>&1 &`
    const entry = fixtureServer('stubborn', {
      envFrom: { PROBE: `${member} sleep 60` },
      envFromTimeoutMs: 300,
    })
    const { connections } = gateway([entry])

    await assert.rejects(() => connections.connect(entry), /PROBE/)

    const pid = recordedPid(pidFile)
    assert.notEqual(pid, 0, 'the background member should have recorded its pid')
    assert.notEqual(pid, process.pid, 'the recorded pid must be the member, not this test')
    // The grace period is 1 s, so anything still alive well past that escaped.
    assert.equal(await processExits(pid, 6000), true, `pid ${pid} survived the timeout`)
  })

  it('AC3c: a command whose leader finished is not reported as a timeout', async () => {
    // The background child inherits the pipes on purpose: `close` then waits for
    // EOF, so the budget expires while the leader is long gone with exit code 0.
    const entry = fixtureServer('bg-holds-pipe', {
      envFrom: { PROBE: 'sleep 60 & printf hello' },
      envFromTimeoutMs: 700,
    })
    const { registry } = gateway([entry])

    const text = await dumpEnv(registry, ['PROBE'])
    assert.match(text, /PROBE=hello/, text)
    await registry.dispose()
  })
})

describe('envFrom — load-time validation', () => {
  it('AC6: a name in both env and envFrom is refused at load', () => {
    const { ctx } = fakeContext()
    assert.throws(
      () =>
        apply(
          ctx as never,
          {
            idleTimeout: 10,
            servers: [
              {
                serverName: 'clash',
                transport: 'stdio',
                command: 'node',
                env: { PROBE: 'from-env' },
                envFrom: { PROBE: 'printf from-command' },
              } as never,
            ],
          } as never,
        ),
      /PROBE/,
    )
  })

  it('AC6b: envFrom on a non-stdio transport is refused at load', () => {
    const { ctx } = fakeContext()
    assert.throws(
      () =>
        apply(
          ctx as never,
          {
            idleTimeout: 10,
            servers: [
              {
                serverName: 'remote',
                transport: 'streamable-http',
                url: 'http://127.0.0.1:1/mcp',
                envFrom: { PROBE: 'printf x' },
              } as never,
            ],
          } as never,
        ),
      /envFrom/,
    )
  })

  it('AC6c: allowEmpty naming an undeclared variable is refused at load', () => {
    const { ctx } = fakeContext()
    assert.throws(
      () =>
        apply(
          ctx as never,
          {
            idleTimeout: 10,
            servers: [
              {
                serverName: 'stray',
                transport: 'stdio',
                command: 'node',
                envFrom: { PROBE: 'printf x' },
                allowEmpty: ['OTHER'],
              } as never,
            ],
          } as never,
        ),
      /OTHER/,
    )
  })

  it('AC6d: an empty command is refused at load', () => {
    const { ctx } = fakeContext()
    assert.throws(
      () =>
        apply(
          ctx as never,
          {
            idleTimeout: 10,
            servers: [
              {
                serverName: 'blank',
                transport: 'stdio',
                command: 'node',
                envFrom: { PROBE: '' },
              } as never,
            ],
          } as never,
        ),
      /PROBE/,
    )
  })
})

describe('envFrom — the value goes nowhere else', () => {
  it('AC7: no file under the DSH home contains the resolved value', async () => {
    const entry = fixtureServer('no-disk', {
      envFrom: { PROBE: `printf ${SENTINEL}` },
    })
    const { registry } = gateway([entry])

    const text = await dumpEnv(registry, ['PROBE'])
    assert.match(text, new RegExp(`PROBE=${SENTINEL}`), text)

    const home = process.env['DSH_HOME'] ?? ''
    const offenders = filesUnder(home).filter(file => readFileSync(file, 'utf8').includes(SENTINEL))
    assert.deepEqual(offenders, [], 'the resolved value must not be persisted anywhere')
    await registry.dispose()
  })

  it('AC8: the resolved value never enters the host process environment', async () => {
    const entry = fixtureServer('no-host-env', {
      envFrom: { PROBE: `printf ${SENTINEL}` },
    })
    const { registry } = gateway([entry])

    await dumpEnv(registry, ['PROBE'])
    const leaked = Object.entries(process.env).filter(([, value]) => value?.includes(SENTINEL))
    assert.deepEqual(leaked, [], 'the value must not be written back to the host environment')
    await registry.dispose()
  })
})

describe('envFrom — metadata cache hashing', () => {
  it('AC9: an entry without envFrom hashes as if the field did not exist', () => {
    const base: ServerEntry = {
      serverName: 'hash',
      transport: 'stdio',
      command: 'node',
      args: ['x'],
      env: { A: '1' },
    }
    assert.equal(
      computeConfigHash({ ...base, envFrom: {}, allowEmpty: [], envFromTimeoutMs: 10_000 }),
      computeConfigHash(base),
      'an empty envFrom must not invalidate every existing cache entry',
    )
  })

  it('AC9b: the digest of an entry without envFrom is pinned to its pre-change value', () => {
    // The value a build of 0.3.3 produced for this exact entry. `envFrom` must
    // not perturb the hash inputs at all when nothing is declared — schemastery
    // defaults it to `{}` on every entry, so getting this wrong would throw
    // away every cached catalog on the first start after an upgrade.
    const entry: ServerEntry = {
      serverName: 'pinned',
      transport: 'stdio',
      command: 'node',
      args: ['a', 'b'],
      env: { K: 'v' },
      cwd: '/tmp',
    }
    assert.equal(
      computeConfigHash(entry),
      '300928223d129fc50a5edc210f601d70f9a4d9a9076805017822f90d5f8f543f',
      'the transport hash of an entry without envFrom must not change',
    )
  })

  it('AC10: a configured command changes the hash', () => {
    const base: ServerEntry = { serverName: 'hash2', transport: 'stdio', command: 'node' }
    assert.notEqual(
      computeConfigHash({ ...base, envFrom: { PROBE: 'printf a' } }),
      computeConfigHash({ ...base, envFrom: { PROBE: 'printf b' } }),
      'the command is transport-relevant and must be hashed',
    )
  })
})
