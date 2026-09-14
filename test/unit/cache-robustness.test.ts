/**
 * Cache robustness, cross-process persistence, and cancellation semantics.
 *
 * Each suite here pins a way for a *non-event* to take the gateway down or make
 * it lie:
 *
 * - a malformed cache file used to throw out of the registry constructor, which
 *   is the plugin load itself, so one bad byte on disk cost every server;
 * - a canceled call used to be recorded as a server failure, so the next caller
 *   was refused for a minute over something the user did on purpose;
 * - the cache used to be written back as the whole-file snapshot taken at
 *   construction, so two DSH processes sharing one `$DSH_HOME` deleted each
 *   other's entries — and entries for servers since removed from the
 *   configuration were never dropped at all;
 * - the cache was written with the process umask, unlike every other file this
 *   plugin writes.
 *
 * The connection layer is stubbed throughout. All of this is reachable without
 * spawning anything, which is exactly why it has to be tested without spawning
 * anything: a test that needs a child process to observe these is a test nobody
 * runs.
 */

import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { tempDir } from '../helpers/tmp.ts'
import {
  buildCacheEntry,
  CACHE_VERSION,
  computeConfigHash,
  loadMetadataCache,
  metadataCachePath,
  saveMetadataCache,
} from '../../lib/metadata-cache.js'
import { McpGatewayRegistry } from '../../lib/registry.js'
import type { GatewayConnection, LiveToolCatalog } from '../../lib/registry.js'
import { DEFAULT_CACHE_MAX_AGE_MS } from '../../lib/schema.js'
import type { Config, ServerEntry, ToolMetadata } from '../../lib/types.js'

/** The exact rejection the connection layer produces for caller cancellation. */
const CANCELED = 'the tool call was canceled before the server connected'

/**
 * Point one suite at a private `$DSH_HOME`.
 *
 * The cache path is resolved on every call rather than captured, so moving the
 * environment variable is enough to isolate a suite from its neighbours.
 *
 * @param prefix - Prefix for the temporary directory name.
 */
function useFreshHome(prefix: string): void {
  let previous: string | undefined
  before(() => {
    previous = process.env['DSH_HOME']
    process.env['DSH_HOME'] = tempDir(prefix)
  })
  after(() => {
    if (previous === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previous
  })
}

/**
 * @param serverName - Namespace for the entry.
 * @param overrides - Fields to replace.
 * @returns A stdio entry that never needs a real command.
 */
function stdioEntry(serverName: string, overrides: Partial<ServerEntry> = {}): ServerEntry {
  return {
    serverName,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', serverName],
    ...overrides,
  }
}

/**
 * @param entries - The configured servers.
 * @returns A configuration holding exactly those servers.
 */
function configFor(...entries: ServerEntry[]): Config {
  return { idleTimeout: 10, servers: entries }
}

/**
 * @param originalName - The server's own tool name.
 * @returns A tool as a live fetch would report it.
 */
function tool(originalName: string): ToolMetadata {
  return { originalName, qualifiedName: originalName, description: `${originalName} tool` }
}

/**
 * Write a cache file verbatim, malformed entries included.
 *
 * `saveMetadataCache` cannot produce these files, which is the point: they come
 * from another version, a hand edit, or a disk that lost a write.
 *
 * @param value - The exact JSON payload to place at the cache path.
 */
function writeRawCache(value: unknown): void {
  const path = metadataCachePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

/** A stub connection that only logs which servers it was asked to start. */
interface StubConnection extends GatewayConnection {
  /** One entry per `connect` call: the spawn-attempt log. */
  connectCalls: ServerEntry[]
}

/**
 * Build a live layer whose only behaviour is the `connect` it is handed.
 *
 * @param connect - What connecting does, including how it fails.
 * @returns The layer, with its call log attached.
 */
function stubConnection(
  connect: (entry: ServerEntry, signal?: AbortSignal) => Promise<LiveToolCatalog>,
): StubConnection {
  const connectCalls: ServerEntry[] = []
  return {
    connectCalls,
    connect: (entry, signal) => {
      connectCalls.push(entry)
      return connect(entry, signal)
    },
    invokeTool: async () => ({ isError: false, blocks: [] }),
    disconnect: async () => undefined,
    isConnected: () => false,
    dispose: async () => undefined,
  }
}

describe('malformed cache entries', () => {
  useFreshHome('dsh-mcp-lazy-robust-')

  it('survives a null entry, which used to throw out of the constructor', () => {
    writeRawCache({ version: CACHE_VERSION, servers: { foo: null } })

    assert.doesNotThrow(
      () => new McpGatewayRegistry(configFor(stdioEntry('foo'))),
      'a cache the plugin cannot parse must cost the entry, never the plugin load',
    )
    assert.deepEqual(
      loadMetadataCache()?.servers,
      {},
      'the illegal entry must not survive the read',
    )
  })

  it('survives an entry with no tools array', () => {
    // The exact shape that used to reach `tools.map`: a matching hash and a
    // fresh timestamp are all the old validator looked at, and neither is
    // present in the body it then dereferenced.
    writeRawCache({
      version: CACHE_VERSION,
      servers: {
        foo: { configHash: computeConfigHash(stdioEntry('foo')), cachedAt: Date.now() },
      },
    })

    assert.doesNotThrow(() => new McpGatewayRegistry(configFor(stdioEntry('foo'))))
    assert.deepEqual(loadMetadataCache()?.servers, {})
  })

  it('drops entries with an unusable hash, timestamp, or tool list', () => {
    const now = Date.now()
    const hash = (name: string): string => computeConfigHash(stdioEntry(name))
    writeRawCache({
      version: CACHE_VERSION,
      servers: {
        'bad-hash': { configHash: 42, cachedAt: now, tools: [] },
        'bad-time': { configHash: hash('bad-time'), cachedAt: 'yesterday', tools: [] },
        'bad-tools': { configHash: hash('bad-tools'), cachedAt: now, tools: 'none' },
        'bad-instructions': {
          configHash: hash('bad-instructions'),
          cachedAt: now,
          tools: [],
          instructions: 7,
        },
        'bad-element': { configHash: hash('bad-element'), cachedAt: now, tools: [null] },
      },
    })

    assert.doesNotThrow(() =>
      new McpGatewayRegistry(
        configFor(
          stdioEntry('bad-hash'),
          stdioEntry('bad-time'),
          stdioEntry('bad-tools'),
          stdioEntry('bad-instructions'),
          stdioEntry('bad-element'),
        ),
      ),
    )
    assert.deepEqual(loadMetadataCache()?.servers, {})
  })

  it('still hydrates every well-formed entry beside them', () => {
    const good = stdioEntry('good')
    const broken = stdioEntry('broken')
    writeRawCache({
      version: CACHE_VERSION,
      servers: {
        good: buildCacheEntry(good, [tool('good-tool')], 'usage text', Date.now()),
        broken: { configHash: computeConfigHash(broken), cachedAt: Date.now() },
      },
    })

    const registry = new McpGatewayRegistry(configFor(good, broken))

    assert.deepEqual(Object.keys(loadMetadataCache()?.servers ?? {}), ['good'])
    assert.equal(registry.hasCatalog('good'), true)
    assert.deepEqual(
      registry.toolsOf('good').map(item => item.originalName),
      ['good-tool'],
      'a validated entry must still be usable',
    )
    assert.equal(registry.instructions('good'), 'usage text')
    assert.equal(registry.hasCatalog('broken'), false)
  })
})

describe('cancellation is not a failure', () => {
  useFreshHome('dsh-mcp-lazy-cancel-')

  it('does not suppress retries after the caller cancels', async () => {
    const entry = stdioEntry('srv')
    let attempts = 0
    const connection = stubConnection((_entry, signal) => {
      attempts += 1
      if (attempts > 1) return Promise.resolve({ tools: [tool('after-cancel')] })
      // Mirrors the real layer: the shared attempt keeps running, and this
      // caller is released as soon as its own signal aborts.
      return new Promise<LiveToolCatalog>((_resolve, reject) => {
        const rejectCanceled = (): void => reject(new Error(CANCELED))
        if (signal?.aborted === true) {
          rejectCanceled()
          return
        }
        signal?.addEventListener('abort', rejectCanceled, { once: true })
      })
    })
    const registry = new McpGatewayRegistry(configFor(entry), connection)
    const controller = new AbortController()

    const canceled = registry.ensureConnected(entry, controller.signal)
    controller.abort()
    await assert.rejects(canceled, /canceled before the server connected/)

    const status = registry.status()[0]
    assert.notEqual(status?.state, 'failed', 'a canceled call must not be reported as a failure')
    assert.equal(status?.failedAgoSeconds, undefined, 'cancellation must not open the retry window')
    assert.equal(status?.lastError, undefined)

    // The next caller is unrelated to the cancel and must simply be served.
    const catalog = await registry.ensureConnected(entry)
    assert.deepEqual(catalog.tools.map(item => item.originalName), ['after-cancel'])
    assert.equal(connection.connectCalls.length, 2)
  })

  it('does not start a server for a call that was already canceled', async () => {
    const entry = stdioEntry('srv')
    const connection = stubConnection(async () => ({ tools: [tool('never-wanted')] }))
    const registry = new McpGatewayRegistry(configFor(entry), connection)
    const controller = new AbortController()
    controller.abort()

    await assert.rejects(registry.ensureConnected(entry, controller.signal), /canceled/)
    assert.equal(
      connection.connectCalls.length,
      0,
      'nobody is waiting for the catalog, so nothing may be spawned for it',
    )
  })

  it('still suppresses automatic retries after a real startup failure', async () => {
    const entry = stdioEntry('broken')
    const connection = stubConnection(async () => {
      throw new Error('spawn ENOENT')
    })
    const registry = new McpGatewayRegistry(
      { ...configFor(entry), failureBackoffMs: 60_000 },
      connection,
    )

    await assert.rejects(registry.ensureConnected(entry), /ENOENT/)
    await assert.rejects(registry.ensureConnected(entry), /not retried automatically for another/)
    assert.equal(connection.connectCalls.length, 1, 'the backoff must not spawn a second attempt')
    assert.equal(registry.status()[0]?.state, 'failed')
  })
})

describe('cross-process cache merging', () => {
  useFreshHome('dsh-mcp-lazy-merge-')

  it('keeps an entry the other process wrote while this one was running', async () => {
    const alpha = stdioEntry('alpha')
    const beta = stdioEntry('beta')
    let round = 0
    const connection = stubConnection(async entry => {
      round += 1
      return { tools: [tool(`${entry.serverName}-r${round}`)] }
    })
    const registry = new McpGatewayRegistry(configFor(alpha, beta), connection)
    await registry.ensureConnected(alpha)

    // The GUI and a CLI share one `$DSH_HOME`, so another process publishes its
    // own server while this registry still holds its construction-time snapshot.
    const disk = loadMetadataCache() ?? { version: CACHE_VERSION, servers: {} }
    disk.servers['beta'] = buildCacheEntry(beta, [tool('beta-from-other-process')], undefined)
    saveMetadataCache(disk)

    await registry.ensureConnected(alpha)

    const after = loadMetadataCache()
    assert.deepEqual(
      after?.servers['beta']?.tools.map(item => item.originalName),
      ['beta-from-other-process'],
      'a whole-file write-back would have deleted the other process\'s entry',
    )
    assert.deepEqual(
      after?.servers['alpha']?.tools.map(item => item.originalName),
      ['alpha-r2'],
      'this session\'s own catalog is the one that must win',
    )
  })

  it('keeps the catalog of a second profile that shares the cache file', async () => {
    // Two profiles (`dsh --profile web`, `dsh --profile cli`) have different
    // server lists but one `$DSH_HOME`, and the cache path carries no profile
    // segment — so neither process may treat the other's servers as deleted.
    // Both are constructed before either connects, which is the case a real
    // pair of long-running processes is in.
    const alpha = stdioEntry('alpha')
    const beta = stdioEntry('beta')
    const connection = stubConnection(async entry => ({
      tools: [tool(`${entry.serverName}-tool`)],
    }))
    const web = new McpGatewayRegistry(configFor(alpha), connection)
    const cli = new McpGatewayRegistry(configFor(beta), connection)

    await web.ensureConnected(alpha)
    await cli.ensureConnected(beta)

    assert.deepEqual(
      Object.keys(loadMetadataCache()?.servers ?? {}).sort(),
      ['alpha', 'beta'],
      "a save must not delete an entry its own configuration cannot judge",
    )
  })

  it('prunes only entries that have aged out for every reader', async () => {
    const alpha = stdioEntry('alpha')
    const connection = stubConnection(async entry => ({
      tools: [tool(`${entry.serverName}-tool`)],
    }))
    const registry = new McpGatewayRegistry(configFor(alpha), connection)
    await registry.ensureConnected(alpha)

    const disk = loadMetadataCache() ?? { version: CACHE_VERSION, servers: {} }
    disk.servers['aged-out'] = buildCacheEntry(
      stdioEntry('aged-out'),
      [tool('aged-out-tool')],
      undefined,
      Date.now() - DEFAULT_CACHE_MAX_AGE_MS - 1000,
    )
    disk.servers['other-profile'] = buildCacheEntry(
      stdioEntry('other-profile'),
      [tool('other-profile-tool')],
      undefined,
    )
    saveMetadataCache(disk)

    await registry.ensureConnected(alpha)

    const after = loadMetadataCache()
    assert.equal(
      after?.servers['aged-out'],
      undefined,
      'an entry past the age bound is unusable to every reader, so it may go',
    )
    assert.ok(
      after?.servers['other-profile'],
      'a fresh entry this configuration cannot judge may belong to another profile',
    )
    assert.ok(after?.servers['alpha'])
  })
})

describe('cache permissions', () => {
  useFreshHome('dsh-mcp-lazy-mode-')

  // Pinned so the assertions below say something on a machine whose umask
  // already hides new files: the plugin has to set the mode itself.
  const originalUmask = process.umask(0o022)
  after(() => process.umask(originalUmask))

  it('creates the cache directory 0700 and the cache file 0600', () => {
    saveMetadataCache({ version: CACHE_VERSION, servers: {} })

    assert.equal(statSync(dirname(metadataCachePath())).mode & 0o777, 0o700)
    assert.equal(statSync(metadataCachePath()).mode & 0o777, 0o600)
  })

  it('tightens a cache file an earlier version left world-readable', () => {
    const path = metadataCachePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{}\n', { encoding: 'utf8', mode: 0o644 })
    chmodSync(path, 0o644)

    saveMetadataCache({ version: CACHE_VERSION, servers: {} })

    assert.equal(statSync(path).mode & 0o777, 0o600, 'the rewrite must not inherit the old mode')
  })
})
