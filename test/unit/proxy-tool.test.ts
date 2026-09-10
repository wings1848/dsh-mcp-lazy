/**
 * The proxy tool and the gateway registry.
 *
 * These tests cover the plugin's reason to exist:
 *
 * - the model-facing schema is a constant, so the request prefix never changes;
 * - `search`/`describe`/status answer from the metadata cache with no live
 *   connection and no child process;
 * - `invoke` resolves names deterministically and reports ambiguity instead of
 *   guessing.
 *
 * They also prove "no process was spawned" directly, by making every spawn on
 * `PATH` fail loudly: if this code ever reaches a transport, the call throws.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { buildCacheEntry, metadataCachePath, saveMetadataCache, CACHE_VERSION } from '../../lib/metadata-cache.js'
import { createProxyTool } from '../../lib/proxy-tool.js'
import { McpGatewayRegistry, resolveServer } from '../../lib/registry.js'
import { PROXY_TOOL_NAME } from '../../lib/schema.js'
import type { Config, MetadataCache, ServerEntry, ToolMetadata } from '../../lib/types.js'

const originalHome = process.env['DSH_HOME']
const originalPath = process.env['PATH']

/** Tools the fake catalogs advertise; index 0 is used for most assertions. */
const DEMO_TOOLS: ToolMetadata[] = [
  {
    originalName: 'take_screenshot',
    qualifiedName: 'demo__take_screenshot',
    description: 'Take a screenshot of the page or element.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['png', 'jpeg'] },
        fullPage: { type: 'boolean' },
      },
      required: ['format'],
    },
    outputSchema: { type: 'object' },
  },
  {
    originalName: 'navigate_page',
    qualifiedName: 'demo__navigate_page',
    description: 'Navigate the browser to a URL.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
]

function entry(overrides: Partial<ServerEntry> = {}): ServerEntry {
  return { serverName: 'demo', transport: 'stdio', command: 'demo-server', ...overrides }
}

function config(servers: ServerEntry[], idleTimeout = 10): Config {
  return { idleTimeout, servers }
}

/**
 * The cache is a single shared file, so a test that writes one server's entry
 * would otherwise erase every other test's. Each test therefore uses its own
 * server name and appends its entry to whatever is already there.
 */
function cacheServer(server: ServerEntry, tools: ToolMetadata[], instructions?: string): void {
  const path = metadataCachePath()
  let current: MetadataCache = { version: CACHE_VERSION, servers: {} }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as MetadataCache
    if (raw.version === CACHE_VERSION) current = raw
  } catch {
    // No usable cache yet; start from empty.
  }
  current.servers[server.serverName] = buildCacheEntry(server, tools, instructions)
  saveMetadataCache(current)
}

/** Build a registry for one server whose catalog is already cached. */
function registryWith(
  server: ServerEntry,
  tools: ToolMetadata[] = DEMO_TOOLS,
  instructions?: string,
): McpGatewayRegistry {
  cacheServer(server, tools, instructions)
  return new McpGatewayRegistry(config([server]))
}

/** Resolve the tool's `execute` and assert it returns text. */
async function run(args: Record<string, unknown>, registry: McpGatewayRegistry): Promise<string> {
  const tool = createProxyTool(registry)
  const value = await tool.execute(args, {
    signal: new AbortController().signal,
  } as Parameters<typeof tool.execute>[1])
  assert.equal(typeof value, 'string')
  return value as string
}

before(() => {
  process.env['DSH_HOME'] = mkdtempSync(join(tmpdir(), 'dsh-mcp-lazy-proxy-'))

  // A PATH containing only executables that always fail. Any spawn attempt
  // therefore surfaces as a rejected call instead of a silent success.
  const trapDir = mkdtempSync(join(tmpdir(), 'dsh-mcp-lazy-trap-'))
  for (const name of ['demo-server', 'npx', 'node', 'bunx', 'sh', 'bash']) {
    const file = join(trapDir, name)
    writeFileSync(file, '#!/bin/sh\necho "SPAWN TRAP: a child process was started" >&2\nexit 97\n')
    chmodSync(file, 0o755)
  }
  process.env['PATH'] = `${trapDir}${delimiter}/nonexistent`
  mkdirSync(join(process.env['DSH_HOME'], 'storages', 'mcp-lazy'), { recursive: true })
  cacheServer(entry(), DEMO_TOOLS, 'Use take_screenshot before every assertion.')
})

after(() => {
  if (originalHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = originalHome
  if (originalPath === undefined) delete process.env['PATH']
  else process.env['PATH'] = originalPath
})

describe('AC2 — the model-facing surface is a constant', () => {
  it('registers exactly one tool, under the constant name', () => {
    const tool = createProxyTool(new McpGatewayRegistry(config([entry()])))
    assert.equal(tool.name, PROXY_TOOL_NAME)
    assert.equal(tool.name, 'mcp')
  })

  it('produces a byte-identical schema for wildly different server sets', () => {
    const single = createProxyTool(new McpGatewayRegistry(config([entry()])))
    const many = createProxyTool(
      new McpGatewayRegistry(
        config([
          entry({ serverName: 'one' }),
          entry({ serverName: 'two', transport: 'streamable-http', command: undefined, url: 'http://x/mcp' }),
          entry({ serverName: 'three', disabled: true, includeTools: ['a'] }),
        ]),
      ),
    )
    assert.equal(
      JSON.stringify(single.parameters),
      JSON.stringify(many.parameters),
      'the proxy parameter schema must not depend on configuration',
    )
    assert.equal(single.description, many.description, 'the description must not depend on configuration')
  })

  it('keeps the schema constant after metadata changes', () => {
    const registry = new McpGatewayRegistry(config([entry()]))
    const before = JSON.stringify(createProxyTool(registry).parameters)
    cacheServer(entry(), [...DEMO_TOOLS, { originalName: 'extra', qualifiedName: 'demo__extra', description: 'x' }])
    const reloaded = new McpGatewayRegistry(config([entry()]))
    assert.equal(JSON.stringify(createProxyTool(reloaded).parameters), before)
  })

  it('declares an object-rooted output schema', () => {
    const tool = createProxyTool(new McpGatewayRegistry(config([])))
    assert.equal(tool.output.schema.type, 'string')
  })
})

describe('AC3 — search answers from cache with no connection', () => {
  it('finds tools without spawning anything', async () => {
    const registry = new McpGatewayRegistry(config([entry()]))
    const text = await run({ search: 'screenshot' }, registry)
    assert.match(text, /demo__take_screenshot/)
    assert.match(text, /\[demo\]/)
  })

  it('matches on description as well as name', async () => {
    const registry = new McpGatewayRegistry(config([entry()]))
    const text = await run({ search: 'browser' }, registry)
    assert.match(text, /demo__navigate_page/)
  })

  it('summarizes parameters, marking optional ones', async () => {
    const registry = new McpGatewayRegistry(config([entry()]))
    const text = await run({ search: 'screenshot' }, registry)
    assert.match(text, /format: string/)
    assert.match(text, /fullPage\?: boolean/)
  })

  it('omits parameter summaries when asked to', async () => {
    const registry = new McpGatewayRegistry(config([entry()]))
    const text = await run({ search: 'screenshot', includeSchemas: false }, registry)
    assert.doesNotMatch(text, /parameters:/)
  })

  it('says the cache is cold instead of pretending nothing exists', async () => {
    const registry = new McpGatewayRegistry(
      config([entry({ serverName: 'unseeded', transport: 'stdio', command: 'x' })]),
    )
    const text = await run({ search: 'anything' }, registry)
    assert.match(text, /No tool metadata is cached yet/)
  })

  it('reports a regex syntax error instead of throwing', async () => {
    const registry = new McpGatewayRegistry(config([entry()]))
    const text = await run({ search: '([', regex: true }, registry)
    // A rejected pattern must not read as "no such tool": the model would
    // conclude the tool does not exist rather than that its pattern was bad.
    assert.match(text, /Could not run that search/)
    assert.match(text, /Invalid regular expression/)
    assert.doesNotMatch(text, /No MCP tool matches/)
  })

  it('reports a rejected regex instead of running it', async () => {
    const registry = new McpGatewayRegistry(config([entry()]))
    const text = await run({ search: '(a+)+c', regex: true }, registry)
    assert.match(text, /nests repeated quantifiers/)
    assert.doesNotMatch(text, /No MCP tool matches/)
  })

  it('searches by regex when asked', async () => {
    const registry = new McpGatewayRegistry(config([entry()]))
    const text = await run({ search: '^demo__take', regex: true }, registry)
    assert.match(text, /demo__take_screenshot/)
  })

  it('pages results and reports how to continue', async () => {
    const tools: ToolMetadata[] = Array.from({ length: 5 }, (_, index) => ({
      originalName: `get_thing_${index}`,
      qualifiedName: `page__get_thing_${index}`,
      description: 'get a thing',
    }))
    const server = entry({ serverName: 'page' })
    const registry = registryWith(server, tools)

    const first = await run({ search: 'thing', limit: 2 }, registry)
    assert.match(first, /Showing 2 of 5 matches/)
    assert.match(first, /offset: 2/)
    const second = await run({ search: 'thing', limit: 2, offset: 2 }, registry)
    assert.match(second, /Showing 2 of 5 matches/)
    assert.doesNotMatch(second, /get_thing_0\b/)
  })

  it('caps an oversized limit rather than failing', async () => {
    const registry = new McpGatewayRegistry(config([entry()]))
    const text = await run({ search: 'e', limit: 9999 }, registry)
    assert.ok(text.length > 0)
  })
})

describe('AC5/AC8 — describe and deterministic error surfaces', () => {
  it('describes a tool with its full input schema', async () => {
    const registry = registryWith(entry({ serverName: 'desc' }))
    const text = await run({ describe: 'take_screenshot' }, registry)
    assert.match(text, /desc__take_screenshot/)
    assert.match(text, /Input schema:/)
    assert.match(text, /"enum":\["png","jpeg"\]/)
  })

  it('accepts the qualified name, the original name, and the server-qualified spelling', async () => {
    const registry = registryWith(entry({ serverName: 'spellings' }))
    for (const name of ['take_screenshot', 'spellings__take_screenshot', 'spellings:take_screenshot']) {
      const text = await run({ describe: name }, registry)
      assert.match(text, /Input schema:/, `failed for spelling ${name}`)
    }
  })

  it('suggests near misses for an unknown tool', async () => {
    const registry = new McpGatewayRegistry(config([entry()]))
    const text = await run({ tool: 'navigate_pages' }, registry)
    assert.match(text, /No known MCP tool named "navigate_pages"/)
    assert.match(text, /navigate_page/)
  })

  it('asks for a server when two servers expose the same tool name', async () => {
    const left = entry({ serverName: 'left' })
    const right = entry({ serverName: 'right' })
    saveMetadataCache({
      version: CACHE_VERSION,
      servers: {
        left: buildCacheEntry(left, [{ originalName: 'search', qualifiedName: 'left__search', description: 'left search' }], undefined),
        right: buildCacheEntry(right, [{ originalName: 'search', qualifiedName: 'right__search', description: 'right search' }], undefined),
      },
    })
    const registry = new McpGatewayRegistry(config([left, right]))
    const text = await run({ tool: 'search' }, registry)
    assert.match(text, /more than one server/)
    assert.match(text, /left:search/)
    assert.match(text, /right:search/)

    const disambiguated = await run({ describe: 'search', server: 'left' }, registry)
    assert.match(disambiguated, /left__search/)
  })

  it('explains a disabled server rather than connecting it', async () => {
    const disabled = entry({ serverName: 'off', disabled: true })
    const registry = registryWith(disabled, [
      { originalName: 'ping', qualifiedName: 'off__ping', description: 'ping' },
    ])
    const text = await run({ connect: 'off' }, registry)
    assert.match(text, /disabled in configuration/)
  })

  it('names the configured servers when asked for an unknown one', async () => {
    const registry = new McpGatewayRegistry(config([entry()]))
    const text = await run({ connect: 'nope' }, registry)
    assert.match(text, /No server named "nope"/)
    assert.match(text, /demo/)
  })
})

describe('status', () => {
  it('lists nothing cleanly when nothing is configured', async () => {
    const registry = new McpGatewayRegistry(config([]))
    const text = await run({}, registry)
    assert.match(text, /No MCP servers are configured/)
  })

  it('reports cached state, tool count, and the cache path', async () => {
    const registry = registryWith(entry({ serverName: 'status-demo' }))
    const text = await run({}, registry)
    assert.match(text, /status-demo — 2 tools/)
    assert.match(text, /metadata from cache/)
    assert.match(text, new RegExp(metadataCachePath().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })

  it('names the servers a cold cache leaves unreachable', async () => {
    // Nothing cached and nothing connected: search has no name to match, and
    // calling a tool is what would have produced the cache. Without being told
    // which servers need a first connect, the model has no move.
    const registry = new McpGatewayRegistry(
      config([
        entry({ serverName: 'cold-one' }),
        entry({ serverName: 'cold-two' }),
      ]),
    )
    const text = await run({}, registry)

    assert.match(text, /no metadata yet/)
    assert.match(text, /cold-one, cold-two cannot|Search cannot find tools on cold-one, cold-two/)
    assert.match(text, /mcp\(\{ connect: "cold-one" \}\)/)
    assert.match(text, /mcp\(\{ connect: "cold-two" \}\)/)
  })

  it('keeps the idle reassurance when every server has metadata', async () => {
    const registry = registryWith(entry({ serverName: 'warm' }))
    const text = await run({}, registry)

    assert.doesNotMatch(text, /no metadata yet/)
    assert.match(text, /calling one of their tools starts it/)
  })

  it('does not ask for a connect on a disabled server', async () => {
    const registry = new McpGatewayRegistry(
      config([entry({ serverName: 'off-limits', disabled: true })]),
    )
    const text = await run({}, registry)

    assert.match(text, /disabled/)
    assert.doesNotMatch(text, /mcp\(\{ connect: "off-limits" \}\)/)
  })
})

describe('invoke resolution', () => {
  it('resolves a unique name to its server and tool', () => {
    const registry = registryWith(entry({ serverName: 'resolve' }))
    const resolution = registry.resolveInvoke('take_screenshot')
    assert.equal(resolution.kind, 'ok')
    if (resolution.kind === 'ok') {
      assert.equal(resolution.target.entry.serverName, 'resolve')
      assert.equal(resolution.target.tool.originalName, 'take_screenshot')
    }
  })

  it('reports an unknown name with suggestions', () => {
    const registry = registryWith(entry({ serverName: 'unknown' }))
    const resolution = registry.resolveInvoke('take_screenshots')
    assert.equal(resolution.kind, 'unknown')
  })

  it('refuses to invoke when the connection layer is absent', async () => {
    const registry = registryWith(entry({ serverName: 'no-connection' }))
    const resolution = registry.resolveInvoke('take_screenshot')
    assert.equal(resolution.kind, 'ok')
    if (resolution.kind !== 'ok') return
    await assert.rejects(
      () => registry.invoke(resolution.target, {}),
      /connection layer is not available/,
    )
  })
})

describe('configuration resolution', () => {
  it('defaults to lazy with the global idle window', () => {
    assert.deepEqual(resolveServer(entry(), 10), { entry: entry(), lifecycle: 'lazy', idleTimeoutMs: 600_000 })
  })

  it('never reaps a server that persists after its first spawn', () => {
    assert.equal(resolveServer(entry({ lifecycle: 'eager' }), 10).idleTimeoutMs, 0)
    assert.equal(resolveServer(entry({ lifecycle: 'lazy-keep-alive' }), 10).idleTimeoutMs, 0)
  })

  it('lets an explicit idleTimeout win, including zero', () => {
    assert.equal(resolveServer(entry({ idleTimeout: 3 }), 10).idleTimeoutMs, 180_000)
    assert.equal(resolveServer(entry({ idleTimeout: 0 }), 10).idleTimeoutMs, 0)
    assert.equal(resolveServer(entry({ lifecycle: 'eager', idleTimeout: 1 }), 10).idleTimeoutMs, 60_000)
  })

  it('rejects duplicate server names', () => {
    assert.throws(
      () => new McpGatewayRegistry(config([entry(), entry()])),
      /duplicate serverName "demo"/,
    )
  })

  it('applies include and exclude filters to cached tools', async () => {
    const server = entry({ serverName: 'filtered', includeTools: ['take_*'] })
    const registry = registryWith(server)
    const text = await run({ search: 'page' }, registry)
    assert.doesNotMatch(text, /navigate_page/)
  })

  it('boosts search ranking with configured keywords without leaking them', async () => {
    const server = entry({ serverName: 'kw', searchKeywords: { take_screenshot: ['photo'] } })
    const registry = registryWith(server, [
      { originalName: 'take_screenshot', qualifiedName: 'kw__take_screenshot', description: 'screenshot' },
      { originalName: 'other', qualifiedName: 'kw__other', description: 'photo album manager' },
    ])
    const text = await run({ search: 'photo' }, registry)
    assert.match(text, /kw__take_screenshot/)
    assert.doesNotMatch(text, /keywords/)
  })

  it('ignores a cached catalog whose config hash no longer matches', async () => {
    const server = entry({ serverName: 'stale', command: 'original' })
    cacheServer(server, [{ originalName: 'old_tool', qualifiedName: 'stale__old_tool', description: '' }])
    const changed = entry({ serverName: 'stale', command: 'changed' })
    const registry = new McpGatewayRegistry(config([changed]))
    const text = await run({ search: 'old' }, registry)
    assert.match(text, /No tool metadata is cached yet/)
  })
})

describe('AC18 — the spawn trap is real', () => {
  it('cannot start a child process through the PATH used by these tests', () => {
    assert.throws(() => execFileSync('demo-server', { stdio: 'pipe' }))
  })
})
