/**
 * AC2b: native-tool promotion.
 *
 * The gateway's default surface is one tool. These tests pin what happens when
 * configuration asks for something else:
 *
 * - `directTools: true` / `string[]` promote tools natively at first sync;
 * - `directTools: 'search'` promotes nothing until a search actually matches,
 *   which is the mode that keeps a session's request prefix untouched;
 * - an unconfigured server promotes nothing at all;
 * - `freezeDirectTools` bounds promotion to the first sync;
 * - promotion never breaks the proxy, which stays the reliable path to every
 *   tool even when a native definition cannot be built.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { tempDir } from '../helpers/tmp.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { DirectToolRegistrar, createNativeTool } from '../../lib/direct-tools.js'
import { qualifiedToolName } from '../../lib/naming.js'
import { createProxyTool } from '../../lib/proxy-tool.js'
import { McpGatewayRegistry } from '../../lib/registry.js'
import type { Config, ServerEntry, ToolMetadata } from '../../lib/types.js'

const originalHome = process.env['DSH_HOME']

before(() => {
  process.env['DSH_HOME'] = tempDir('dsh-mcp-lazy-direct-')
})

after(() => {
  if (originalHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = originalHome
})

/** Two servers, each with two tools, already in the cache. */
function twoServers(overrides: Partial<ServerEntry> = {}): ServerEntry[] {
  return [
    { serverName: 'alpha', transport: 'stdio', command: 'alpha-server', ...overrides },
    { serverName: 'beta', transport: 'stdio', command: 'beta-server' },
  ]
}

/** Build a registry with a catalog already recorded, via a stub connection. */
async function loadedRegistry(
  entries: ServerEntry[],
  catalogs: Record<string, ToolMetadata[]>,
  extra: Partial<Config> = {},
): Promise<McpGatewayRegistry> {
  const connection = {
    connect: async (entry: ServerEntry) => ({ tools: catalogs[entry.serverName] ?? [] }),
    invokeTool: async () => ({ isError: false, blocks: [] }),
    disconnect: async () => undefined,
    isConnected: () => false,
    dispose: async () => undefined,
  }
  const registry = new McpGatewayRegistry(
    { idleTimeout: 10, servers: entries, ...extra },
    connection,
  )
  for (const entry of entries) await registry.ensureConnected(entry).catch(() => undefined)
  return registry
}

/** A registrar wired to a recording register function. */
function registrarFor(
  registry: McpGatewayRegistry,
  freeze = false,
): { registrar: DirectToolRegistrar; registered: Map<string, ToolDefinition> } {
  const registered = new Map<string, ToolDefinition>()
  const registrar = new DirectToolRegistrar(
    registry,
    definition => {
      registered.set(definition.name, definition)
      return () => void registered.delete(definition.name)
    },
    freeze,
  )
  return { registrar, registered }
}

function tool(serverName: string, originalName: string, description = `${originalName} tool`): ToolMetadata {
  return {
    originalName,
    qualifiedName: qualifiedToolName(serverName, originalName),
    description,
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  }
}

const CATALOGS: Record<string, ToolMetadata[]> = {
  alpha: [tool('alpha', 'read_file'), tool('alpha', 'write_file')],
  beta: [tool('beta', 'search_docs'), tool('beta', 'fetch_page')],
}

describe('AC2b — directTools: off by default', () => {
  it('promotes nothing when no server asks for it', async () => {
    const registry = await loadedRegistry(twoServers(), CATALOGS)
    const { registrar, registered } = registrarFor(registry)
    assert.deepEqual(registrar.sync(), [])
    assert.equal(registered.size, 0)
    assert.deepEqual(registry.directToolSelections(), [])
    assert.deepEqual(registry.searchModeServers(), [])
  })
})

describe('AC2b — directTools: true / string[]', () => {
  it('promotes every tool of a server configured with true', async () => {
    const entries = twoServers()
    entries[0]!.directTools = true
    const registry = await loadedRegistry(entries, CATALOGS)
    const { registrar, registered } = registrarFor(registry)

    const added = registrar.sync()
    assert.deepEqual(
      added.sort(),
      ['alpha__read_file', 'alpha__write_file'],
      `failures: ${JSON.stringify([...registrar.failures])}`,
    )
    assert.equal(registered.size, 2)
    assert.equal(registered.has('beta__search_docs'), false, 'only the configured server promotes')
  })

  it('promotes only the named tools for a string list, matching globs', async () => {
    const entries = twoServers()
    entries[0]!.directTools = ['read_*']
    const registry = await loadedRegistry(entries, CATALOGS)
    const { registrar, registered } = registrarFor(registry)

    assert.deepEqual(registrar.sync(), ['alpha__read_file'])
    assert.equal(registered.has('alpha__write_file'), false)
  })

  it('is idempotent across repeated syncs', async () => {
    const entries = twoServers()
    entries[0]!.directTools = true
    const registry = await loadedRegistry(entries, CATALOGS)
    const { registrar, registered } = registrarFor(registry)

    registrar.sync()
    assert.deepEqual(registrar.sync(), [])
    assert.equal(registered.size, 2)
  })

  it('gives the model each tool once, and the proxy stays registered too', async () => {
    const entries = twoServers()
    entries[0]!.directTools = true
    const registry = await loadedRegistry(entries, CATALOGS)
    const { registrar, registered } = registrarFor(registry)
    registrar.sync()

    assert.equal(registered.has('mcp'), false, 'promotion must not displace the proxy')
    assert.ok(createProxyTool(registry), 'the proxy is always constructible')
    assert.equal(registered.size, 2)
  })

  it('carries the server description and the advertised schema into the definition', async () => {
    const entries = twoServers()
    entries[0]!.directTools = ['read_file']
    const registry = await loadedRegistry(entries, CATALOGS)
    const { registrar, registered } = registrarFor(registry)
    registrar.sync()

    const definition = registered.get('alpha__read_file')
    assert.ok(definition)
    assert.match(definition.description, /read_file tool/)
    assert.match(definition.description, /MCP server: alpha/)
    assert.deepEqual(
      (definition.parameters as { properties?: unknown }).properties,
      { q: { type: 'string' } },
    )
  })

  it('builds a native definition that calls back through the registry', async () => {
    const entries = twoServers()
    const registry = await loadedRegistry(entries, CATALOGS)
    const definition = createNativeTool(registry, entries[0]!, CATALOGS['alpha']![0]!)
    const value = await definition.execute({ q: 'x' }, {
      signal: new AbortController().signal,
    } as never)
    assert.equal(typeof value, 'string')
  })
})

describe("AC2b — directTools: 'search'", () => {
  it('promotes nothing until a search matches', async () => {
    const entries = twoServers()
    entries[0]!.directTools = 'search'
    const registry = await loadedRegistry(entries, CATALOGS)
    const { registrar, registered } = registrarFor(registry)

    assert.deepEqual(registrar.sync(), [], 'staging must register nothing')
    assert.equal(registered.size, 0)
    assert.deepEqual(registry.searchModeServers(), ['alpha'])
    assert.equal(registrar.state.staged.size, 2, 'both tools are staged')

    const activated = registrar.activateFromSearch('read_file')
    assert.deepEqual(activated, ['alpha__read_file'])
    assert.equal(registered.size, 1, 'only the matched tool becomes native')
    assert.equal(registered.has('alpha__write_file'), false)
  })

  it('leaves servers not in search mode out of activation', async () => {
    const entries = twoServers()
    entries[0]!.directTools = 'search'
    const registry = await loadedRegistry(entries, CATALOGS)
    const { registrar, registered } = registrarFor(registry)
    registrar.sync()

    assert.deepEqual(registrar.activateFromSearch('docs'), [])
    assert.equal(registered.size, 0)
  })

  it('reports the newly native tools to the model after a search', async () => {
    const entries = twoServers()
    entries[0]!.directTools = 'search'
    const registry = await loadedRegistry(entries, CATALOGS)
    const { registrar } = registrarFor(registry)
    registrar.sync()

    const proxy = createProxyTool(registry, (query, options) =>
      registrar.activateFromSearch(query, options),
    )
    const rendered = String(
      await proxy.execute({ search: 'read_file' }, {
        signal: new AbortController().signal,
      } as never),
    )
    assert.match(rendered, /alpha__read_file/)
    assert.match(rendered, /Now callable directly as native tools: alpha__read_file/)
  })

  it('activation is idempotent', async () => {
    const entries = twoServers()
    entries[0]!.directTools = 'search'
    const registry = await loadedRegistry(entries, CATALOGS)
    const { registrar } = registrarFor(registry)
    registrar.sync()

    assert.deepEqual(registrar.activateFromSearch('read_file'), ['alpha__read_file'])
    assert.deepEqual(registrar.activateFromSearch('read_file'), [])
  })
})

describe('AC2b — plugin-level directTools default', () => {
  it('promotes every server when the plugin default is true', async () => {
    // pi-mcp-adapter exposes this as `settings.directTools`, so a configuration
    // carried over from it expects to find one.
    const registry = await loadedRegistry(twoServers(), CATALOGS, { directTools: true })
    const { registrar, registered } = registrarFor(registry)

    assert.deepEqual(registrar.sync().sort(), [
      'alpha__read_file',
      'alpha__write_file',
      'beta__fetch_page',
      'beta__search_docs',
    ])
    assert.equal(registered.size, 4)
  })

  it('lets one server opt out of the plugin default', async () => {
    const entries = twoServers()
    entries[0]!.directTools = false
    const registry = await loadedRegistry(entries, CATALOGS, { directTools: true })
    const { registrar } = registrarFor(registry)

    assert.deepEqual(registrar.sync().sort(), ['beta__fetch_page', 'beta__search_docs'])
  })

  it('lets one server pick named promotion under a plugin default of true', async () => {
    const entries = twoServers()
    entries[0]!.directTools = ['read_*']
    const registry = await loadedRegistry(entries, CATALOGS, { directTools: true })
    const { registrar } = registrarFor(registry)

    assert.deepEqual(registrar.sync().sort(), [
      'alpha__read_file',
      'beta__fetch_page',
      'beta__search_docs',
    ])
  })

  it("applies a plugin default of 'search' to every server", async () => {
    const registry = await loadedRegistry(twoServers(), CATALOGS, { directTools: 'search' })
    const { registrar, registered } = registrarFor(registry)

    assert.deepEqual(registrar.sync(), [])
    assert.equal(registered.size, 0)
    assert.deepEqual(registry.searchModeServers().sort(), ['alpha', 'beta'])
  })
})

describe('AC2b — freezeDirectTools', () => {
  it('stops accepting new promotions after the first pass', async () => {
    const entries = twoServers()
    entries[0]!.directTools = true
    const registry = await loadedRegistry(entries, CATALOGS)
    const { registrar, registered } = registrarFor(registry, true)

    registrar.sync()
    assert.equal(registered.size, 2)

    // A later catalog change must not move the surface again.
    registry.recordRefreshedCatalog('alpha', {
      tools: [...CATALOGS['alpha']!, tool('alpha', 'brand_new')],
    })
    assert.deepEqual(registrar.sync(), [])
    assert.equal(registered.size, 2)
    assert.equal(registered.has('alpha__brand_new'), false)
  })

  it('promotes nothing on the first pass when there is nothing to promote', async () => {
    const registry = await loadedRegistry(twoServers(), CATALOGS)
    const { registrar, registered } = registrarFor(registry, true)
    assert.deepEqual(registrar.sync(), [])
    assert.equal(registered.size, 0)
  })
})

describe('AC2b — promotion never breaks the proxy', () => {
  it('survives a registration that throws', async () => {
    const entries = twoServers()
    entries[0]!.directTools = true
    const registry = await loadedRegistry(entries, CATALOGS)
    const registrar = new DirectToolRegistrar(registry, () => {
      throw new Error('the host refused this definition')
    })

    assert.deepEqual(registrar.sync(), [])
    assert.equal(registrar.state.registered.size, 0)
  })

  it('drops every native registration on dispose', async () => {
    const entries = twoServers()
    entries[0]!.directTools = true
    const registry = await loadedRegistry(entries, CATALOGS)
    const { registrar, registered } = registrarFor(registry)
    registrar.sync()
    assert.equal(registered.size, 2)

    registrar.dispose()
    assert.equal(registered.size, 0)
    assert.equal(registrar.state.registered.size, 0)
  })

  it('ignores a server that is not configured', async () => {
    const registry = await loadedRegistry(twoServers(), CATALOGS)
    const { registrar, registered } = registrarFor(registry)
    assert.equal(registrar.activateFromSearch('anything').length, 0)
    assert.equal(registered.size, 0)
  })
})
