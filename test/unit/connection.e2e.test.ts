/**
 * M2: lazy startup, call, reaping, and failure behaviour against a real MCP
 * server process.
 *
 * These tests spawn `test/fixtures/mcp-server.mjs` for real, so they assert on
 * process facts rather than mocks: a server that was never called left no
 * process behind, a second call reused the first process, an idle one was
 * reaped and re-spawned, and a call in progress was never reaped underneath
 * itself.
 *
 * The fixture appends one line to `FIXTURE_START_COUNT` per process start, which
 * is how "was a new process spawned" is observed without guessing from pids.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { tempDir } from '../helpers/tmp.ts'
import { LazyConnections } from '../../lib/connection.js'
import { apply } from '../../lib/index.js'
import { metadataCachePath } from '../../lib/metadata-cache.js'
import { qualifiedToolName } from '../../lib/naming.js'
import { OutputGuard } from '../../lib/output-guard.js'
import { createProxyTool } from '../../lib/proxy-tool.js'
import { McpGatewayRegistry, resolveServer } from '../../lib/registry.js'
import type { Config, ServerEntry, ToolCallResult } from '../../lib/types.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, '..', 'fixtures', 'mcp-server.mjs')
const originalHome = process.env['DSH_HOME']

let workdir: string

/**
 * Every connection layer built by a test. Disposed in `after` so a failing
 * assertion cannot leave a child process alive holding the test runner open.
 */
const layers: LazyConnections[] = []

/** Every output guard built by a test, so their spill files are cleaned up. */
const guards: OutputGuard[] = []

/** Build a guard that is disposed with the suite. */
function outputGuard(options?: ConstructorParameters<typeof OutputGuard>[0]): OutputGuard {
  const built = new OutputGuard(options)
  guards.push(built)
  return built
}

before(() => {
  workdir = tempDir('dsh-mcp-lazy-e2e-')
  process.env['DSH_HOME'] = join(workdir, 'home')
})

after(async () => {
  await Promise.all(layers.map(layer => layer.dispose().catch(() => undefined)))
  await Promise.all(guards.map(instance => instance.dispose().catch(() => undefined)))
  if (originalHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = originalHome
})

/** Count how many times a fixture server has started. */
function startCount(file: string): number {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(line => line !== '').length
  } catch {
    return 0
  }
}

/**
 * Wait for a pid to disappear.
 *
 * `close()` is asynchronous, so a just-killed child is briefly a zombie and
 * signal 0 still succeeds against one. Polling keeps the test fast when the
 * process dies promptly and honest when it does not.
 *
 * @param pid - The process to watch.
 * @param timeoutMs - How long to wait before concluding it is still alive.
 * @returns True once the process is gone.
 */
async function childExits(pid: number, timeoutMs = 5000): Promise<boolean> {
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

/** Read the pid the fixture last reported. */
function lastPid(file: string): string {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * Build a stdio server entry pointed at the fixture.
 *
 * @param serverName - Namespace for the server.
 * @param overrides - Entry overrides, including the idle window.
 * @param options - Fixture environment knobs.
 * @returns The entry plus the files used to observe the process.
 */
function fixtureServer(
  serverName: string,
  overrides: Partial<ServerEntry> = {},
  options: { idleWindowMs?: number; env?: Record<string, string> } = {},
): { entry: ServerEntry; counterFile: string; pidFile: string } {
  const counterFile = join(workdir, `${serverName}.starts`)
  const pidFile = join(workdir, `${serverName}.pid`)
  const entry: ServerEntry = {
    serverName,
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    env: {
      FIXTURE_START_COUNT: counterFile,
      FIXTURE_PID_FILE: pidFile,
      ...(options.env ?? {}),
    },
    toolCallTimeoutMs: 5000,
    ...overrides,
  }
  return { entry, counterFile, pidFile }
}

/** A registry wired to a real lazy connection layer. */
function gateway(
  entries: ServerEntry[],
  idleWindowMs: (entry: ServerEntry) => number,
  extra: Partial<Config> = {},
): { registry: McpGatewayRegistry; connections: LazyConnections } {
  const connections = new LazyConnections(idleWindowMs, { startSweeper: false })
  layers.push(connections)
  connections.setQualifier(qualifiedToolName)
  const config: Config = { idleTimeout: 10, servers: entries, ...extra }
  const registry = new McpGatewayRegistry(config, connections)
  registry.bindLiveCatalogRefresh()
  return { registry, connections }
}

/** Call one tool directly through the registry, awaiting connection. */
async function call(
  registry: McpGatewayRegistry,
  tool: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<ToolCallResult> {
  const { resolution } = await registry.discoverAndResolve(tool, undefined, signal)
  assert.equal(resolution.kind, 'ok', `expected to resolve ${tool}, got ${resolution.kind}`)
  if (resolution.kind !== 'ok') throw new Error('unreachable')
  return registry.invoke(resolution.target, args, signal)
}

describe('M2 — lazy startup', () => {
  it('spawns nothing until a tool is actually called', async () => {
    const { entry, counterFile, pidFile } = fixtureServer('lazy')
    const { registry, connections } = gateway([entry], () => 600_000)

    assert.equal(startCount(counterFile), 0, 'no process may exist before the first call')
    assert.equal(lastPid(pidFile), '')
    assert.equal(connections.isConnected('lazy'), false)

    // Discovery is cache-only, so it must not start anything either.
    registry.search('echo')
    assert.equal(startCount(counterFile), 0)

    const result = await call(registry, 'echo', { text: 'hi' })
    assert.equal(result.isError, false)
    assert.equal(result.blocks[0]?.type, 'text')
    assert.equal(
      result.blocks[0]?.type === 'text' ? result.blocks[0].text : '',
      'echo: hi',
    )
    assert.equal(startCount(counterFile), 1)

    await registry.dispose()
  })

  it('reuses one process for repeated calls', async () => {
    const { entry, counterFile, pidFile } = fixtureServer('reuse')
    const { registry } = gateway([entry], () => 600_000)

    await call(registry, 'self_report')
    const firstPid = lastPid(pidFile)
    await call(registry, 'self_report')
    await call(registry, 'echo', { text: 'again' })

    assert.equal(startCount(counterFile), 1, 'a connected server must not be re-spawned')
    assert.equal(lastPid(pidFile), firstPid, 'the same process must serve every call')

    await registry.dispose()
  })

  it('shares one process between concurrent first calls', async () => {
    const { entry, counterFile } = fixtureServer('concurrent')
    const { registry } = gateway([entry], () => 600_000)

    const results = await Promise.all([
      call(registry, 'echo', { text: 'a' }),
      call(registry, 'echo', { text: 'b' }),
      call(registry, 'echo', { text: 'c' }),
    ])
    assert.equal(results.length, 3)
    assert.equal(startCount(counterFile), 1, 'concurrent first calls must share one spawn')

    await registry.dispose()
  })

  it('names discovered tools deterministically from the server namespace', async () => {
    const { entry } = fixtureServer('naming')
    const { registry } = gateway([entry], () => 600_000)

    // Nothing is known yet, so a search has nothing to report.
    assert.equal(registry.search('echo').coldCache, true)

    // Calling by the server's own name discovers the server and resolves it.
    const result = await call(registry, 'echo', { text: 'x' })
    assert.equal(result.isError, false)

    const search = registry.search('echo')
    assert.equal(search.matches[0]?.tool, 'naming__echo')
    assert.equal(registry.search('echo').coldCache, false)

    // The same name must describe the same tool afterwards.
    assert.equal(registry.resolveInvoke('naming__echo').kind, 'ok')
    assert.equal(registry.resolveInvoke('echo').kind, 'ok')

    await registry.dispose()
  })

  it('writes the fetched catalog to the metadata cache for the next session', async () => {
    const { entry } = fixtureServer('cached')
    const { registry } = gateway([entry], () => 600_000)
    await call(registry, 'echo', { text: 'x' })
    await registry.dispose()

    const raw = JSON.parse(readFileSync(metadataCachePath(), 'utf8')) as {
      servers: Record<string, { tools: { originalName: string }[] }>
    }
    const names = raw.servers['cached']?.tools.map(tool => tool.originalName) ?? []
    assert.ok(names.includes('echo'), `expected echo in cache, got ${names.join(',')}`)
    assert.ok(names.includes('slow'))
  })
})

describe('M2 — tool call results', () => {
  it('projects a server-reported error as an error', async () => {
    const { entry } = fixtureServer('errors')
    const { registry } = gateway([entry], () => 600_000)
    const result = await call(registry, 'always_fails')
    assert.equal(result.isError, true)
    assert.equal(result.blocks[0]?.type, 'text')

    const tool = createProxyTool(registry)
    const rendered = await tool.execute({ tool: 'always_fails' }, {
      signal: new AbortController().signal,
    } as never)
    assert.match(String(rendered), /reported an error/)
    assert.match(String(rendered), /this tool always fails/)

    await registry.dispose()
  })

  it('reports image payloads as metadata instead of dropping them', async () => {
    const { entry } = fixtureServer('images')
    const { registry } = gateway([entry], () => 600_000)
    const result = await call(registry, 'get_pixels')
    const image = result.blocks.find(block => block.type === 'image')
    assert.ok(image, 'the image block must survive projection')
    assert.equal(image.type === 'image' ? image.mimeType : '', 'image/png')
    assert.equal(image.type === 'image' ? image.bytes : 0, 5)

    const tool = createProxyTool(registry)
    const rendered = String(
      await tool.execute({ tool: 'get_pixels' }, { signal: new AbortController().signal } as never),
    )
    assert.match(rendered, /here is the image/)
    assert.match(rendered, /\[image: image\/png, 5 bytes/)

    await registry.dispose()
  })

  it('surfaces a tool failure as readable text rather than a throw', async () => {
    const { entry } = fixtureServer('failures')
    const { registry } = gateway([entry], () => 600_000)
    const tool = createProxyTool(registry)
    // Call before connecting, with an unknown tool: deterministic text.
    const rendered = String(
      await tool.execute({ tool: 'nope' }, { signal: new AbortController().signal } as never),
    )
    assert.match(rendered, /No known MCP tool named "nope"/)
  })
})

describe('M2 — cancellation and failure', () => {
  it('honours caller cancellation', async () => {
    const { entry } = fixtureServer('cancel')
    const { registry } = gateway([entry], () => 600_000)
    // Connect first so the cancellation lands on the call, not the handshake.
    await call(registry, 'echo', { text: 'warm' })

    const controller = new AbortController()
    const pending = call(registry, 'slow', { ms: 3000 }, controller.signal)
    setTimeout(() => controller.abort(), 150)
    await assert.rejects(pending)

    // The server must still be usable afterwards.
    const after = await call(registry, 'echo', { text: 'still here' })
    assert.equal(after.isError, false)

    await registry.dispose()
  })

  it('enforces the per-call timeout', async () => {
    const { entry } = fixtureServer('timeout', { toolCallTimeoutMs: 400 })
    const { registry } = gateway([entry], () => 600_000)
    await assert.rejects(() => call(registry, 'slow', { ms: 4000 }), /timed out|timeout/i)
    await registry.dispose()
  })

  it('reports a server that cannot start, and retries on the next call', async () => {
    const { entry } = fixtureServer('broken', {}, { env: { FIXTURE_FAIL: '1' } })
    const { registry, connections } = gateway([entry], () => 600_000)

    await assert.rejects(() => call(registry, 'echo', { text: 'x' }))
    assert.equal(connections.isConnected('broken'), false)
    assert.equal(registry.status().find(server => server.serverName === 'broken')?.state, 'failed')

    // A failed attempt must not poison the next one.
    await assert.rejects(() => call(registry, 'echo', { text: 'x' }))
    await registry.dispose()
  })

  it('drops a connection whose process died and reconnects on demand', async () => {
    const { entry, counterFile } = fixtureServer(
      'crash',
      {},
      { env: { FIXTURE_EXIT_AFTER_MS: '900' } },
    )
    const { registry, connections } = gateway([entry], () => 600_000)

    const first = await call(registry, 'self_report')
    assert.equal(first.isError, false)
    assert.equal(startCount(counterFile), 1)

    // Let the fixture exit on its own.
    await new Promise(resolve => setTimeout(resolve, 1400))
    assert.equal(connections.isConnected('crash'), false, 'a dead process must not stay connected')

    const second = await call(registry, 'self_report')
    assert.equal(second.isError, false)
    assert.equal(startCount(counterFile), 2, 'the next call must start a fresh process')

    await registry.dispose()
  })

  it('kills the child when the catalog fetch fails after the handshake', async () => {
    // The window that matters: the server is up and `initialize` succeeded, so
    // the SDK considers the connection established. Then `tools/list` fails.
    // Nothing else in this suite covers it — FIXTURE_FAIL exits before the
    // handshake, which the SDK cleans up by itself.
    const { entry, pidFile } = fixtureServer(
      'half-open',
      {},
      { env: { FIXTURE_FAIL_TOOLS_LIST: '1' } },
    )
    const connections = new LazyConnections(() => 600_000, { startSweeper: false })
    layers.push(connections)
    connections.setQualifier(qualifiedToolName)

    await assert.rejects(() => connections.connect(entry), /tools\/list/i)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    assert.ok(Number.isInteger(pid) && pid > 0, 'the fixture must have recorded its pid')
    assert.equal(await childExits(pid), true, 'the child must not outlive a failed connect')

    // And the leak must not compound: a second attempt leaves nothing behind
    // either, because the first attempt already released its process.
    await assert.rejects(() => connections.connect(entry), /tools\/list/i)
    assert.equal(connections.isConnected('half-open'), false)

    await connections.dispose()
  })
})

describe('M2 — idle reaping', () => {
  it('reaps an idle server and re-spawns it on the next call', async () => {
    const { entry, counterFile, pidFile } = fixtureServer('reap')
    let clock = Date.now()
    const connections = new LazyConnections(() => 1000, { startSweeper: false, now: () => clock })
    layers.push(connections)
    connections.setQualifier(qualifiedToolName)
    const registry = new McpGatewayRegistry({ idleTimeout: 10, servers: [entry] }, connections)
    registry.bindLiveCatalogRefresh()

    await call(registry, 'echo', { text: 'one' })
    const firstPid = lastPid(pidFile)
    assert.equal(connections.isConnected('reap'), true)
    assert.deepEqual(await connections.sweepIdle(), [], 'a fresh connection must not be reaped')

    clock += 5000
    assert.deepEqual(await connections.sweepIdle(), ['reap'])
    assert.equal(connections.isConnected('reap'), false)

    await call(registry, 'echo', { text: 'two' })
    assert.equal(startCount(counterFile), 2)
    assert.notEqual(lastPid(pidFile), firstPid, 'a fresh process must serve the later call')

    await registry.dispose()
  })

  it('never reaps a call that is still in flight', async () => {
    const { entry, counterFile } = fixtureServer('inflight')
    let clock = Date.now()
    const connections = new LazyConnections(() => 1000, { startSweeper: false, now: () => clock })
    layers.push(connections)
    connections.setQualifier(qualifiedToolName)
    const registry = new McpGatewayRegistry({ idleTimeout: 10, servers: [entry] }, connections)
    registry.bindLiveCatalogRefresh()

    const pending = call(registry, 'slow', { ms: 1200 })
    // Cross the idle window while the call is running, then try to reap.
    await new Promise(resolve => setTimeout(resolve, 150))
    clock += 60_000
    assert.deepEqual(await connections.sweepIdle(), [], 'an in-flight call must block reaping')

    const result = await pending
    assert.equal(result.isError, false)
    assert.equal(
      result.blocks[0]?.type === 'text' ? result.blocks[0].text : '',
      'waited 1200ms',
    )
    assert.equal(startCount(counterFile), 1, 'the call must have completed on the original process')

    await registry.dispose()
  })

  it('never reaps a server configured to persist (window 0)', async () => {
    const { entry } = fixtureServer('persist', { lifecycle: 'keep-alive' })
    let clock = Date.now()
    const connections = new LazyConnections(() => 0, { startSweeper: false, now: () => clock })
    layers.push(connections)
    connections.setQualifier(qualifiedToolName)
    const registry = new McpGatewayRegistry({ idleTimeout: 10, servers: [entry] }, connections)
    registry.bindLiveCatalogRefresh()

    await call(registry, 'echo', { text: 'x' })
    clock += 3_600_000
    assert.deepEqual(await connections.sweepIdle(), [])
    assert.equal(connections.isConnected('persist'), true)

    await registry.dispose()
  })

  it('disposes every connection and stops the sweep timer', async () => {
    const { entry } = fixtureServer('disposal')
    const { registry, connections } = gateway([entry], () => 600_000)
    await call(registry, 'echo', { text: 'x' })
    assert.equal(connections.isConnected('disposal'), true)

    await registry.dispose()
    assert.equal(connections.isConnected('disposal'), false)
    // Disposal must be idempotent.
    await registry.dispose()
  })
})

describe('M2 — independent of any live server', () => {
  it('keeps answering status while every server is down', async () => {
    const { entry } = fixtureServer('down', {}, { env: { FIXTURE_FAIL: '1' } })
    const { registry, connections } = gateway([entry], () => 600_000)
    const tool = createProxyTool(registry)

    const rendered = String(
      await tool.execute({ connect: 'down' }, { signal: new AbortController().signal } as never),
    )
    assert.match(rendered, /Could not connect server "down"/)

    const status = String(
      await tool.execute({}, { signal: new AbortController().signal } as never),
    )
    assert.match(status, /failed/)
    assert.equal(connections.isConnected('down'), false)
  })

  it('does not claim both copies run while the local one is failed', async () => {
    // The native-server warning is appended to this very listing, which prints
    // `failed` and the spawn error for the server it is talking about. A sentence
    // claiming "both run" therefore contradicted its own output; it now states
    // configuration only.
    const { entry } = fixtureServer('down-native', {}, { env: { FIXTURE_FAIL: '1' } })
    const { registry } = gateway([entry], () => 600_000)
    const tool = createProxyTool(registry, undefined, undefined, ['down-native'])

    await tool.execute(
      { connect: 'down-native' },
      { signal: new AbortController().signal } as never,
    )
    const status = String(
      await tool.execute({}, { signal: new AbortController().signal } as never),
    )
    assert.match(status, /down-native — 0 tools .*failed/)
    assert.match(status, /⚠ 1 server \(down-native\) is configured both here and in/)
    assert.doesNotMatch(status, /both run/)
    assert.doesNotMatch(status, /both work/i)
  })
})

describe('M2 — cold-start discovery', () => {
  it('finds and calls a tool by its bare name without any prior connect', async () => {
    const { entry, counterFile } = fixtureServer('coldstart')
    const { registry } = gateway([entry], () => 600_000)

    // Nothing is known, nothing is running.
    assert.equal(startCount(counterFile), 0)
    assert.equal(registry.search('echo').coldCache, true)

    // The model calls the server's own tool name; the gateway goes looking.
    const result = await call(registry, 'echo', { text: 'found me' })
    assert.equal(result.isError, false)
    assert.equal(
      result.blocks[0]?.type === 'text' ? result.blocks[0].text : '',
      'echo: found me',
    )
    assert.equal(startCount(counterFile), 1)

    await registry.dispose()
  })

  it('searches across servers it has never connected to, one handshake at a time', async () => {
    const first = fixtureServer('scan-a', {}, { env: { FIXTURE_FAIL: '1' } })
    const second = fixtureServer('scan-b')
    const { registry } = gateway([first.entry, second.entry], () => 600_000)

    // scan-a cannot start; the search must skip it and still find scan-b.
    const result = await call(registry, 'self_report')
    assert.equal(result.isError, false)
    assert.equal(startCount(second.counterFile), 1)

    // The broken server's diagnostic must survive for status output.
    const status = registry.status().find(server => server.serverName === 'scan-a')
    assert.equal(status?.state, 'failed')
    assert.ok(status?.lastError !== undefined)

    await registry.dispose()
  })

  it('stops looking at the first server that resolves the name', async () => {
    const first = fixtureServer('order-1')
    const second = fixtureServer('order-2')
    const { registry } = gateway([first.entry, second.entry], () => 600_000)

    await call(registry, 'echo', { text: 'x' })
    assert.equal(startCount(first.counterFile), 1, 'the first server must be tried first')
    assert.equal(startCount(second.counterFile), 0, 'the second server must stay untouched')

    await registry.dispose()
  })
})

describe('stdio environment boundaries', () => {
  it('drops credential-shaped and DSH_* names while keeping explicit overrides', async () => {
    process.env['MY_SERVICE_TOKEN'] = 'leaked-token'
    process.env['DB_PASSWORD'] = 'leaked-password'
    process.env['SOME_SECRET'] = 'leaked-secret'
    process.env['DSH_SESSION_ID'] = 'leaked-session'
    process.env['HARMLESS_MARKER'] = 'kept'

    const { entry } = fixtureServer('envcheck', {}, {
      env: { EXPLICIT_OVERRIDE: 'present' },
    })
    const { registry } = gateway([entry], () => 600_000)

    const result = await call(registry, 'dump_env', {
      names: [
        'MY_SERVICE_TOKEN',
        'DB_PASSWORD',
        'SOME_SECRET',
        'DSH_SESSION_ID',
        'HARMLESS_MARKER',
        'EXPLICIT_OVERRIDE',
        'FIXTURE_PID_FILE',
      ],
    })
    const text = result.blocks
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('\n')

    assert.match(text, /MY_SERVICE_TOKEN=<unset>/, text)
    assert.match(text, /DB_PASSWORD=<unset>/, text)
    assert.match(text, /SOME_SECRET=<unset>/, text)
    assert.match(text, /DSH_SESSION_ID=<unset>/, text)
    assert.match(text, /HARMLESS_MARKER=kept/, text)
    assert.match(text, /EXPLICIT_OVERRIDE=present/, text)
    assert.match(text, /FIXTURE_PID_FILE=/, 'the fixture env the entry declares must arrive')

    await registry.dispose()
  })
})

describe('live tool-list refresh', () => {
  it('picks up a tool the server adds mid-session, without changing the tool surface', async () => {
    const { entry } = fixtureServer('refresh')
    const { registry } = gateway([entry], () => 600_000)

    const before = createProxyTool(registry)
    const beforeSchema = JSON.stringify(before.parameters)

    await call(registry, 'echo', { text: 'warm' })
    assert.equal(registry.search('brand_new').matches.length, 0)

    // The server gains a tool and notifies its clients.
    const added = await call(registry, 'add_tool', { name: 'brand_new' })
    assert.equal(added.isError, false)

    // The refresh is asynchronous: wait for the catalog to catch up.
    const deadline = Date.now() + 5000
    while (registry.search('brand_new').matches.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(
      registry.search('brand_new').matches.length,
      1,
      'the refreshed catalog must expose the new tool',
    )

    // The model-facing schema must not have moved.
    assert.equal(JSON.stringify(createProxyTool(registry).parameters), beforeSchema)

    // And the new tool must be callable through the gateway.
    const result = await call(registry, 'brand_new')
    assert.equal(result.isError, false)

    await registry.dispose()
  })

  it('persists the refreshed catalog to disk', async () => {
    const { entry } = fixtureServer('refresh-cache')
    const { registry } = gateway([entry], () => 600_000)
    await call(registry, 'echo', { text: 'warm' })
    await call(registry, 'add_tool', { name: 'cached_dynamic' })

    const deadline = Date.now() + 5000
    let names: string[] = []
    while (Date.now() < deadline) {
      try {
        const raw = JSON.parse(readFileSync(metadataCachePath(), 'utf8')) as {
          servers: Record<string, { tools: { originalName: string }[] }>
        }
        names = raw.servers['refresh-cache']?.tools.map(tool => tool.originalName) ?? []
      } catch {
        names = []
      }
      if (names.includes('cached_dynamic')) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.ok(names.includes('cached_dynamic'), `cache should hold the new tool, got ${names.join(',')}`)

    await registry.dispose()
  })
})

/**
 * The cache must hold the server's *full* tool list, with `includeTools` /
 * `excludeTools` applied when it is read.
 *
 * Storing the filtered list instead stays invisible until a filter is loosened:
 * re-filtering an already-filtered catalog can only ever remove more, and
 * `configHash` ignores the filter fields, so the missing tool could never be
 * recovered from disk. These tests pin both directions.
 */
describe('M6 — include/exclude filters are read-side only', () => {
  it('removing an exclusion brings the tool back from cache, with no reconnect', async () => {
    const { entry, counterFile } = fixtureServer('filter-loosen', { excludeTools: ['echo'] })

    const first = gateway([entry], () => 600_000)
    await first.registry.ensureConnected(entry)
    assert.equal(first.registry.search('echo').matches.length, 0, 'excluded tool must be hidden')

    // Same server, exclusion dropped. Constructing this registry reads the
    // cache; nothing here may spawn a process.
    const before = startCount(counterFile)
    const second = gateway([{ ...entry, excludeTools: [] }], () => 600_000)
    const visible = second.registry.search('echo').matches.length

    assert.equal(startCount(counterFile), before, 'the cache must answer without starting a server')
    assert.equal(visible, 1, 'dropping an exclusion must restore the tool from cache')
  })

  it('adding an exclusion hides a cached tool, with no reconnect', async () => {
    const { entry, counterFile } = fixtureServer('filter-tighten')

    const first = gateway([entry], () => 600_000)
    await first.registry.ensureConnected(entry)
    assert.equal(first.registry.search('echo').matches.length, 1)

    const before = startCount(counterFile)
    const second = gateway([{ ...entry, excludeTools: ['echo'] }], () => 600_000)

    assert.equal(second.registry.search('echo').matches.length, 0)
    assert.equal(startCount(counterFile), before)
  })

  it('caches the unfiltered catalog even when the filter hides most tools', async () => {
    const { entry } = fixtureServer('filter-store', { includeTools: ['echo'] })

    const first = gateway([entry], () => 600_000)
    const catalog = await first.registry.ensureConnected(entry)
    assert.ok(catalog.tools.length > 1, 'fixture should advertise several tools')
    assert.equal(first.registry.search('echo').matches.length, 1)

    const raw = JSON.parse(readFileSync(metadataCachePath(), 'utf8')) as {
      servers: Record<string, { tools: { originalName: string }[] }>
    }
    const stored = raw.servers['filter-store']?.tools.map(tool => tool.originalName) ?? []

    assert.ok(
      stored.includes('get_pixels'),
      `cache must keep tools the filter hides, got ${stored.join(',')}`,
    )
  })
})

/**
 * The output ceiling has to hold on the real path, not just in isolation: the
 * fixture's `echo` returns whatever it is given, which is the cheapest way to
 * make a server emit an arbitrarily large result.
 */
describe('M7 — oversized results are bounded', () => {
  /** Run the proxy tool with a guard attached. */
  async function proxyCall(
    registry: McpGatewayRegistry,
    args: Record<string, unknown>,
    outputGuard: OutputGuard,
  ): Promise<string> {
    const tool = createProxyTool(registry, undefined, outputGuard)
    const value = await tool.execute(args, {
      signal: new AbortController().signal,
    } as Parameters<typeof tool.execute>[1])
    return String(value)
  }

  it('spills a large tool result and keeps the head inline', async () => {
    const { entry } = fixtureServer('guard-large')
    const { registry } = gateway([entry], () => 600_000)
    const guard = outputGuard({ maxBytes: 512, maxLines: 10_000 })

    const body = `${'HEAD'.repeat(10)}${'Z'.repeat(200_000)}`
    const text = await proxyCall(registry, { tool: 'echo', args: { text: body } }, guard)

    assert.match(text, /MCP output truncated/)
    assert.ok(text.startsWith('echo: HEAD'), text.slice(0, 40))
    assert.ok(!text.includes('Z'.repeat(1000)), 'the huge tail must not be inline')
    assert.ok(text.length < 5000, `inline text should stay small, got ${text.length}`)
  })

  it('leaves a small tool result untouched', async () => {
    const { entry } = fixtureServer('guard-small')
    const { registry } = gateway([entry], () => 600_000)
    const guard = outputGuard()

    const text = await proxyCall(registry, { tool: 'echo', args: { text: 'hello' } }, guard)

    assert.equal(text, 'echo: hello')
    assert.doesNotMatch(text, /truncated/)
  })

  it('spills with the full payload, not the truncated one', async () => {
    const { entry } = fixtureServer('guard-spill')
    const { registry } = gateway([entry], () => 600_000)
    const guard = outputGuard({ maxBytes: 256, maxLines: 10_000 })

    const tail = 'TAIL-MARKER-9f3a'
    const text = await proxyCall(
      registry,
      { tool: 'echo', args: { text: `${'A'.repeat(50_000)}${tail}` } },
      guard,
    )

    const path = /Full text saved to: (\S+)/.exec(text)?.[1]
    assert.ok(path !== undefined, text.slice(0, 400))
    const spilled = readFileSync(path, 'utf8')
    assert.ok(spilled.includes(tail), 'the spilled file must hold the tail that was cut')
  })

  it('does not guard the metadata the gateway generates itself', async () => {
    const { entry } = fixtureServer('guard-search')
    const { registry } = gateway([entry], () => 600_000)
    // Warm the catalog, or the search has nothing to render but the cold-cache
    // hint and this test would pass for the wrong reason.
    await registry.ensureConnected(entry)
    // A ceiling of one byte would mangle any search output that went through it.
    const guard = outputGuard({ maxBytes: 1, maxLines: 1 })

    const text = await proxyCall(registry, { search: 'echo' }, guard)

    assert.doesNotMatch(text, /truncated/)
    assert.match(text, /echo/)
  })
})

/**
 * A server that cannot start is an everyday condition — a wrong command, a
 * missing dependency, a credential that expired. What matters is that the
 * failure explains itself once, and that it does not get re-attempted (and
 * re-timed-out) on every subsequent call.
 */
describe('M8 — failing servers are diagnosable and not retried blindly', () => {
  /** The fixture that dies before speaking MCP, after logging to stderr. */
  function failingServer(serverName: string): { entry: ServerEntry; counterFile: string } {
    const { entry, counterFile } = fixtureServer(serverName, {}, { env: { FIXTURE_FAIL: '1' } })
    return { entry, counterFile }
  }

  it('surfaces the child stderr tail in the connection error', async () => {
    const { entry } = failingServer('stderr-tail')
    const { registry } = gateway([entry], () => 600_000)

    await assert.rejects(
      () => registry.ensureConnected(entry),
      (error: Error) => {
        // The SDK's own message says nothing about why; the child does.
        assert.match(error.message, /fixture: configured to fail before serving/)
        return true
      },
    )
  })

  it('refuses an automatic retry inside the backoff window, without spawning', async () => {
    const { entry, counterFile } = failingServer('backoff')
    const { registry } = gateway([entry], () => 600_000, { failureBackoffMs: 60_000 })

    await assert.rejects(() => registry.ensureConnected(entry))
    assert.equal(startCount(counterFile), 1)

    await assert.rejects(
      () => registry.ensureConnected(entry),
      /failed \d+s ago and is not retried automatically/,
    )
    assert.equal(startCount(counterFile), 1, 'the backoff must not spawn a second process')
  })

  it('lets an explicit connect override the backoff', async () => {
    const { entry, counterFile } = failingServer('backoff-force')
    const { registry } = gateway([entry], () => 600_000, { failureBackoffMs: 60_000 })

    await assert.rejects(() => registry.ensureConnected(entry))
    assert.equal(startCount(counterFile), 1)

    // Someone who has just fixed the command must not have to wait it out.
    await assert.rejects(() => registry.ensureConnected(entry, undefined, { force: true }))
    assert.equal(startCount(counterFile), 2, 'force must actually retry')
  })

  it('retries again once the window has passed', async () => {
    const { entry, counterFile } = failingServer('backoff-elapsed')
    // A zero-length window means "never suppress": the seam a test uses
    // instead of waiting out a real minute.
    const { registry } = gateway([entry], () => 600_000, { failureBackoffMs: 0 })

    await assert.rejects(() => registry.ensureConnected(entry))
    await assert.rejects(() => registry.ensureConnected(entry))
    assert.equal(startCount(counterFile), 2)
  })

  it('reports the suppression in status', async () => {
    const { entry } = failingServer('backoff-status')
    const { registry } = gateway([entry], () => 600_000, { failureBackoffMs: 60_000 })

    await assert.rejects(() => registry.ensureConnected(entry))
    const status = registry.status()[0]

    assert.equal(status?.state, 'failed')
    assert.equal(typeof status?.failedAgoSeconds, 'number')
    assert.match(status?.lastError ?? '', /configured to fail/)
  })

  it('clears the suppression once a retry succeeds', async () => {
    // Start failing, then let a forced retry reach a working server: the
    // suppression must not outlive the condition that caused it.
    const { entry, counterFile } = fixtureServer('backoff-recover', {}, { env: { FIXTURE_FAIL: '1' } })
    const { registry } = gateway([{ ...entry, env: { ...entry.env, FIXTURE_FAIL: '' } }], () => 600_000, {
      failureBackoffMs: 60_000,
    })

    // Fail first, using the entry that carries the failing environment.
    await assert.rejects(() => registry.ensureConnected(entry))
    assert.equal(registry.status()[0]?.failedAgoSeconds !== undefined, true)

    // The configured entry (without FIXTURE_FAIL) starts fine, so a forced
    // retry clears both the suppression and the recorded error.
    const catalog = await registry.ensureConnected(registry.servers[0] as ServerEntry, undefined, {
      force: true,
    })
    assert.ok(catalog.tools.length > 0)
    assert.equal(registry.status()[0]?.failedAgoSeconds, undefined)
    assert.equal(registry.status()[0]?.lastError, undefined)
    assert.ok(startCount(counterFile) >= 2)
  })
})

describe('M9 — activation connects only what asked to be resident', () => {
  /**
   * Poll until `check` passes.
   *
   * Activation connects are deliberately fire-and-forget so a slow server cannot
   * delay the model-facing tool surface, which means there is no promise for a
   * test to await. Observing the fixture's start counter is the alternative.
   */
  async function waitFor(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (check()) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error(`timed out waiting for ${label}`)
  }

  it('selects exactly eager and keep-alive, and never a disabled server', () => {
    const entries = [
      fixtureServer('pick-lazy').entry,
      fixtureServer('pick-lazy-keep', { lifecycle: 'lazy-keep-alive' }).entry,
      fixtureServer('pick-eager', { lifecycle: 'eager' }).entry,
      fixtureServer('pick-keep', { lifecycle: 'keep-alive' }).entry,
      fixtureServer('pick-disabled', { lifecycle: 'keep-alive', disabled: true }).entry,
    ]
    const registry = new McpGatewayRegistry({ idleTimeout: 10, servers: entries })

    assert.deepEqual(
      registry.residentServers().map(entry => entry.serverName),
      ['pick-eager', 'pick-keep'],
    )
  })

  it('spawns the resident servers while applying the plugin, and leaves the lazy ones alone', async () => {
    // Two servers, not four: which lifecycles are resident is settled without
    // processes by the test above, so this one only has to show that a resident
    // server really is started at activation and a lazy one really is not.
    // Spawning fewer children keeps it off the clock, which matters on a slow
    // filesystem where four concurrent node starts is enough to blow a timeout.
    const lazy = fixtureServer('boot-lazy')
    const eager = fixtureServer('boot-eager', { lifecycle: 'eager' })

    const disposers: (() => void)[] = []
    const ctx = {
      tools: { register: () => () => {} },
      effect: (callback: () => () => void) => {
        disposers.push(callback())
      },
      // The command registry is optional, so this fake never delivers it — which
      // is also the case that matters: the gateway has to activate regardless.
      inject: () => ({}),
    }

    apply(ctx as never, {
      idleTimeout: 10,
      servers: [lazy.entry, eager.entry],
    } as never)

    try {
      await waitFor(
        () => startCount(eager.counterFile) >= 1,
        'the eager server to be spawned at activation',
      )
      assert.equal(startCount(lazy.counterFile), 0, 'lazy must not spawn during activation')
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('starts the adopted server and never the row it was moved out of', async () => {
    // The end state this whole feature produces, asserted as a pair of process
    // counts. Two plugins would both answer for `same-server`; after the move,
    // the row that used to serve it carries `disabled: true` and the server is
    // this plugin's. So: the adopted entry starts when a call needs it (proving
    // the move did not disable the wrong thing) and the disabled row produces no
    // process at all (proving the duplicate really is inert).
    //
    // "Nothing happened" is the hard half and the one that has no symptom: a
    // disabled server that still spawns looks exactly like a working one.
    const adopted = fixtureServer('adopt-kept')
    const dropped = fixtureServer('adopt-dropped', { disabled: true })

    const disposers: (() => void)[] = []
    const ctx = {
      tools: { register: () => () => {} },
      effect: (callback: () => () => void) => {
        disposers.push(callback())
      },
      // The command registry is optional, so this fake never delivers it — which
      // is also the case that matters: the gateway has to activate regardless.
      inject: () => ({}),
    }

    apply(ctx as never, { idleTimeout: 10, servers: [adopted.entry, dropped.entry] } as never)
    try {
      // Activation alone starts nothing: both entries are lazy.
      assert.equal(startCount(adopted.counterFile), 0)
      assert.equal(startCount(dropped.counterFile), 0)

      const connections = new LazyConnections(() => 600_000, { startSweeper: false })
      layers.push(connections)
      connections.setQualifier(qualifiedToolName)
      const registry = new McpGatewayRegistry(
        { idleTimeout: 10, servers: [adopted.entry, dropped.entry] },
        connections,
      )
      await registry.ensureConnected(adopted.entry, new AbortController().signal)
      assert.equal(startCount(adopted.counterFile), 1, 'the adopted server must start')

      // The disabled row is refused, and refused before anything is spawned.
      await assert.rejects(
        registry.ensureConnected(dropped.entry, new AbortController().signal),
        /disabled in configuration/,
      )
      assert.equal(
        startCount(dropped.counterFile),
        0,
        'the disabled entry must never produce a process',
      )
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('gives every lifecycle but lazy an unlimited idle window', () => {
    const windowFor = (overrides: Partial<ServerEntry>): number =>
      resolveServer(
        { serverName: 'x', transport: 'stdio', command: 'x', ...overrides },
        10,
      ).idleTimeoutMs

    assert.equal(windowFor({}), 600_000, 'an omitted lifecycle is lazy and inherits the global window')
    assert.equal(windowFor({ lifecycle: 'lazy' }), 600_000)
    assert.equal(windowFor({ lifecycle: 'lazy-keep-alive' }), 0)
    assert.equal(windowFor({ lifecycle: 'eager' }), 0)
    assert.equal(windowFor({ lifecycle: 'keep-alive' }), 0, 'keep-alive must never be reaped')

    // An explicit window wins over the lifecycle default, `0` included.
    assert.equal(windowFor({ lifecycle: 'keep-alive', idleTimeout: 3 }), 180_000)
    assert.equal(windowFor({ lifecycle: 'lazy', idleTimeout: 0 }), 0)
  })

  it('never reaps a keep-alive server, going through the real lifecycle rule', async () => {
    const { entry } = fixtureServer('ka-real', { lifecycle: 'keep-alive' })
    let clock = Date.now()
    const connections = new LazyConnections(
      server => resolveServer(server, 10).idleTimeoutMs,
      { startSweeper: false, now: () => clock },
    )
    layers.push(connections)
    connections.setQualifier(qualifiedToolName)
    const registry = new McpGatewayRegistry({ idleTimeout: 10, servers: [entry] }, connections)
    registry.bindLiveCatalogRefresh()

    await call(registry, 'echo', { text: 'x' })
    clock += 3_600_000
    assert.deepEqual(await connections.sweepIdle(), [], 'an hour idle must not reap keep-alive')
    assert.equal(connections.isConnected('ka-real'), true)

    await registry.dispose()
  })
})
