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
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { tempDir } from '../helpers/tmp.ts'
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

/** `status` output for a registry, with the native plugin's servers supplied. */
async function statusWith(
  registry: McpGatewayRegistry,
  native: readonly string[],
): Promise<string> {
  const tool = createProxyTool(registry, undefined, undefined, native)
  return String(
    await tool.execute({}, { signal: new AbortController().signal } as Parameters<
      typeof tool.execute
    >[1]),
  )
}

before(() => {
  process.env['DSH_HOME'] = tempDir('dsh-mcp-lazy-proxy-')

  // A PATH containing only executables that always fail. Any spawn attempt
  // therefore surfaces as a rejected call instead of a silent success.
  const trapDir = tempDir('dsh-mcp-lazy-trap-')
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

  it('warns when another plugin is registering the same servers natively', async () => {
    // Both plugins serve it, nothing clashes, and the saving silently does not
    // happen -- so the model has to be the one that notices and says so.
    const registry = new McpGatewayRegistry(config([entry({ serverName: 'shared' })]))
    const text = await statusWith(registry, ['shared'])
    assert.match(
      text,
      /⚠ 1 server \(shared\) is configured both here and in @deepseek-ai\/dsh-mcp-client/,
    )
    assert.match(text, /Remove it from one of the two/)
    assert.doesNotMatch(text, /is enabled in @deepseek-ai\/dsh-mcp-client/)
    assert.doesNotMatch(text, /This gateway does not have/)
  })

  it('claims configuration, not liveness, about the two copies', async () => {
    // The wording that shipped said "Nothing clashes and both run", which the
    // listing can contradict: a local entry whose start failed prints `failed`
    // plus its spawn error directly above this sentence. That state needs a real
    // connection layer, so it is built in `connection.e2e.test.ts`; what is
    // pinned here is that the claim itself is gone.
    const registry = new McpGatewayRegistry(config([entry({ serverName: 'both-copies' })]))
    const text = await statusWith(registry, ['both-copies'])
    assert.match(text, /⚠ 1 server \(both-copies\) is configured both here and in/)
    assert.doesNotMatch(text, /both run/)
    assert.doesNotMatch(text, /both work/i)
  })

  it('does not claim overlap for a server this gateway does not have', async () => {
    // The overlap wording shipped once without checking, so it announced that
    // "both plugins" were serving a server this gateway never had. The advice
    // differs by state, so the states are rendered apart.
    const registry = new McpGatewayRegistry(config([entry({ serverName: 'mine' })]))
    const text = await statusWith(registry, ['absent'])
    assert.match(text, /⚠ 1 server \(absent\) is enabled in @deepseek-ai\/dsh-mcp-client/)
    assert.match(text, /This gateway does not have it; add it here/)
    assert.doesNotMatch(text, /both here and in/)
  })

  it('tells a disabled entry to be enabled, never to be added again', async () => {
    // The advice must not be "move it here": the server is already here, and a
    // second entry with the same serverName makes the registry constructor throw
    // `mcp-lazy: duplicate serverName`, so the plugin would fail to load.
    const registry = new McpGatewayRegistry(
      config([entry({ serverName: 'off-here', disabled: true })]),
    )
    const text = await statusWith(registry, ['off-here'])
    assert.match(text, /⚠ 1 server \(off-here\) is enabled in @deepseek-ai\/dsh-mcp-client/)
    assert.match(text, /This gateway lists it with `disabled: true`/)
    assert.match(text, /clear that flag/)
    assert.doesNotMatch(text, /add it here/)
    assert.doesNotMatch(text, /both here and in/)
  })

  it('reports an entry it cannot match instead of dropping it in silence', async () => {
    // `detectNativelyRegistered` substitutes `(unnamed)` when an entry's
    // `serverName` is not a plain string, which is exactly what a `!!js`
    // expression looks like in the loader's raw options -- and such a row does
    // register tools under its evaluated name, so dropping it was a false
    // negative. The notice claims matchability, not absence: a config that spells
    // the placeholder literally puts the same string in the same list, and "has no
    // serverName" would be false of that one.
    const registry = new McpGatewayRegistry(config([]))
    const text = await statusWith(registry, ['(unnamed)'])
    assert.match(
      text,
      /⚠ 1 entry in @deepseek-ai\/dsh-mcp-client has no serverName this gateway can match/,
    )
    assert.match(text, /It is not compared against this gateway's list/)
    assert.match(text, /so check it by hand/)
    assert.ok(text.includes('a name outside /^[A-Za-z0-9_-]{1,32}$/'))
    assert.doesNotMatch(text, /\(unnamed\)/)
    assert.doesNotMatch(text, /registers MCP tools natively/)
    assert.doesNotMatch(text, /has no plain/)

    // It coexists with the named sentences rather than replacing them.
    const mixed = await statusWith(registry, ['codegraph', '(unnamed)'])
    assert.match(mixed, /⚠ 1 server \(codegraph\) is enabled in @deepseek-ai\/dsh-mcp-client/)
    assert.match(mixed, /⚠ 1 entry in @deepseek-ai\/dsh-mcp-client has no serverName/)

    // Two nameless rows are two rows, even though they report the same placeholder
    // -- the dedupe that collapses a repeated *name* must not collapse these, and
    // the rest of the sentence has to agree with its own count.
    const twice = await statusWith(registry, ['(unnamed)', '(unnamed)'])
    assert.match(
      twice,
      /⚠ 2 entries in @deepseek-ai\/dsh-mcp-client have no serverName this gateway can match/,
    )
    assert.match(twice, /They are not compared against this gateway's list/)
    assert.match(twice, /so check them by hand/)
  })

  it('tells a case-only difference apart from an absent server', async () => {
    // Both plugins key servers by exact name, so `Mine` beside `mine` is not the
    // same entry, and "add it here" would leave two servers doing the same job.
    const registry = new McpGatewayRegistry(config([entry({ serverName: 'Mine' })]))
    const text = await statusWith(registry, ['mine'])
    assert.match(text, /⚠ 1 server \(mine\) is enabled in @deepseek-ai\/dsh-mcp-client/)
    assert.match(text, /This gateway's list uses `Mine`, differing only by case/)
    assert.match(text, /separate namespaces rather than one entry/)
    assert.match(text, /keep one row and delete the rest/)
    assert.match(text, /Mine — 0 tools/)
    assert.doesNotMatch(text, /This gateway does not have/)

    const two = await statusWith(
      new McpGatewayRegistry(
        config([entry({ serverName: 'Mine' }), entry({ serverName: 'Yours' })]),
      ),
      ['mine', 'yours'],
    )
    assert.match(two, /⚠ 2 servers \(mine, yours\) are enabled in/)
    assert.match(two, /This gateway's list uses `Mine` and `Yours`, differing only by case/)
  })

  it('names the live spelling and marks each switched-off one', async () => {
    // A switched-off case-variant must not be the row named when a live one exists.
    const preferLive = await statusWith(
      new McpGatewayRegistry(
        config([entry({ serverName: 'Mine', disabled: true }), entry({ serverName: 'mine' })]),
      ),
      ['MINE'],
    )
    assert.match(preferLive, /This gateway's list uses `mine`, differing only by case/)

    // The marker belongs to the spelling, not to the sentence: a switched-off row
    // beside a live one must still carry it, and a sentence-wide flag dropped it.
    const mixedOff = await statusWith(
      new McpGatewayRegistry(
        config([entry({ serverName: 'Mine', disabled: true }), entry({ serverName: 'Yours' })]),
      ),
      ['mine', 'yours'],
    )
    assert.match(mixedOff, /This gateway's list uses `Mine` \(switched off\) and `Yours`,/)
    assert.doesNotMatch(mixedOff, /`Yours` \(switched off\)/)

    // Two switched-off rows, each marked: a trailing suffix after both names read as
    // applying to the last of them.
    const bothOff = await statusWith(
      new McpGatewayRegistry(
        config([
          entry({ serverName: 'Mine', disabled: true }),
          entry({ serverName: 'Yours', disabled: true }),
        ]),
      ),
      ['mine', 'yours'],
    )
    assert.match(
      bothOff,
      /This gateway's list uses `Mine` \(switched off\) and `Yours` \(switched off\),/,
    )
  })

  it('reduces rows when several native spellings fold onto one configured name', async () => {
    // Naming that spelling twice read as a claim that there were two of it.
    const folded = await statusWith(
      new McpGatewayRegistry(config([entry({ serverName: 'MINE' })])),
      ['Mine', 'mine', 'MiNe'],
    )
    assert.match(folded, /⚠ 3 servers \(Mine, mine, MiNe\) are enabled in/)
    assert.equal((folded.match(/`MINE`/g) ?? []).length, 1)

    // Several native spellings cannot all be renamed to the one local spelling:
    // mcp-client rejects the second row with that serverName ("already in use by
    // another mcp-client instance"), so the advice reduces rows instead of merging
    // names.
    const twoVariants = await statusWith(
      new McpGatewayRegistry(config([entry({ serverName: 'MINE' })])),
      ['Mine', 'mine'],
    )
    assert.match(twoVariants, /⚠ 2 servers \(Mine, mine\) are enabled in/)
    assert.match(twoVariants, /keep one row and delete the rest/)
    assert.equal((twoVariants.match(/`MINE`/g) ?? []).length, 1)
    assert.doesNotMatch(twoVariants, /Spell .* the same/)

    // The same listing can hold both sentences without them contradicting: the
    // different-case one must not ask for the rename that would recreate the
    // duplicate the `both` sentence just asked to remove.
    const together = await statusWith(
      new McpGatewayRegistry(config([entry({ serverName: 'Mine' })])),
      ['mine', 'Mine'],
    )
    assert.match(together, /⚠ 1 server \(Mine\) is configured both here and in/)
    assert.match(together, /⚠ 1 server \(mine\) is enabled in @deepseek-ai\/dsh-mcp-client/)
    assert.doesNotMatch(together, /Spell .* the same/)
  })

  it('counts every string it cannot match, not only the placeholder', async () => {
    // A blank name and an over-long one are just as unmatchable as a substituted
    // placeholder, and counting only the placeholder made the number disagree with
    // the sentence printing it: a blank row beside one `!!js` row said `1 entry`
    // for two rows.
    const registry = new McpGatewayRegistry(config([]))
    assert.match(
      await statusWith(registry, ['']),
      /⚠ 1 entry in @deepseek-ai\/dsh-mcp-client has no serverName this gateway can match/,
    )
    assert.match(
      await statusWith(registry, ['x'.repeat(33)]),
      /⚠ 1 entry in @deepseek-ai\/dsh-mcp-client has no serverName this gateway can match/,
    )
    assert.match(
      await statusWith(registry, ['(unnamed)', '']),
      /⚠ 2 entries in @deepseek-ai\/dsh-mcp-client have no serverName this gateway can match/,
    )
  })

  it('ignores names from the array form that are not strings at all', async () => {
    // `RegExp.test` coerces its argument and `join` renders `null` as nothing, so
    // these reached the sentence as `()` and `(42)` before the seam was typed.
    const registry = new McpGatewayRegistry(config([]))
    const seam = [undefined, null, 42] as unknown as string[]
    assert.doesNotMatch(await statusWith(registry, seam), /dsh-mcp-client/)
  })

  it('refuses a non-array native source instead of spelling it out', async () => {
    // The exported seam is caller-supplied, and a bare string is iterable: the
    // dedupe pass used to spell `'abc'` into three servers named `a`, `b` and
    // `c`. Names fabricated out of nothing are worse than the `TypeError` this
    // call raised before the sentence was split in three.
    const registry = new McpGatewayRegistry(config([]))
    const tool = createProxyTool(registry, undefined, undefined, 'abc' as unknown as string[])
    const text = String(
      await tool.execute({}, { signal: new AbortController().signal } as Parameters<
        typeof tool.execute
      >[1]),
    )
    assert.doesNotMatch(text, /dsh-mcp-client/)
  })

  it('describes the native plugin instead of claiming what enters a request', async () => {
    // Two reviews found this clause asserting an effect this code cannot see: a
    // native row whose config mcp-client rejects (it needs `transport` plus
    // `command` or `url`) registers nothing, and neither does one whose server is
    // down, because mcp-client drops a server whose reconnect budget is spent. The
    // reason is now that plugin's mode, which holds in both states.
    const registry = new McpGatewayRegistry(config([]))
    const text = await statusWith(registry, ['codegraph'])
    assert.match(text, /registers MCP tools natively instead of leaving them behind/)
    assert.match(text, /disable the native row if you do not need it/)
    assert.doesNotMatch(text, /every request/)
    assert.doesNotMatch(text, /as a native tool/)
  })

  it('counts a duplicated native name once', async () => {
    // Two loader entries with one name are one server: the second instance fails
    // mcp-client's own "already in use" check.
    const registry = new McpGatewayRegistry(config([]))
    const text = await statusWith(registry, ['dup', 'dup'])
    assert.match(text, /⚠ 1 server \(dup\) is enabled in/)
    assert.doesNotMatch(text, /2 servers/)
  })

  it('groups all three states in one listing', async () => {
    const registry = new McpGatewayRegistry(
      config([entry({ serverName: 'shared' }), entry({ serverName: 'off-here', disabled: true })]),
    )
    const text = await statusWith(registry, ['shared', 'off-here', 'absent'])
    assert.match(text, /1 server \(shared\) is configured both here and in/)
    assert.match(text, /1 server \(off-here\) is enabled in/)
    assert.match(text, /1 server \(absent\) is enabled in/)
  })

  it('pluralises every warning', async () => {
    const registry = new McpGatewayRegistry(
      config([entry({ serverName: 'a' }), entry({ serverName: 'b' })]),
    )
    const text = await statusWith(registry, ['a', 'b', 'c', 'd'])
    assert.match(text, /⚠ 2 servers \(a, b\) are configured both here and in/)
    assert.match(text, /⚠ 2 servers \(c, d\) are enabled in/)
  })

  it('says nothing about a conflict when there is none', async () => {
    const registry = new McpGatewayRegistry(config([entry({ serverName: 'alone' })]))
    const text = await run({}, registry)
    assert.doesNotMatch(text, /dsh-mcp-client/)
  })

  it('still warns when no servers are configured here', async () => {
    // The other plugin alone is the state a user lands in by configuring MCP in
    // the wrong place, which is the case this exists for.
    const registry = new McpGatewayRegistry(config([]))
    const text = await statusWith(registry, ['orphaned'])
    assert.match(text, /No MCP servers are configured/)
    assert.match(
      text,
      /⚠ 1 server \(orphaned\) is enabled in @deepseek-ai\/dsh-mcp-client/,
    )
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

describe('the gateway argument envelope', () => {
  /**
   * A gateway with nothing cached: every call answers from local state, so these
   * assertions are about argument handling and never touch a server.
   *
   * @returns A tool whose results can be called and read as text.
   */
  function tool(): {
    call: (args: Record<string, unknown>) => Promise<string>
  } {
    const registry = new McpGatewayRegistry({ idleTimeout: 10, servers: [] })
    const definition = createProxyTool(registry)
    return {
      call: async args =>
        String(
          await definition.execute(args, { signal: new AbortController().signal } as Parameters<
            typeof definition.execute
          >[1]),
        ),
    }
  }

  it('accepts flat arguments, the way a direct caller passes them', async () => {
    const text = await tool().call({ search: 'anything' })
    assert.match(text, /nothing to search/)
    assert.doesNotMatch(text, /No known MCP tool/)
  })

  it('unwraps the envelope a gateway-named tool is dispatched with', async () => {
    // The host reserves `mcp` for "call any tool" and delivers arguments as
    // `{ tool: "<the tool being called>", args: <its arguments> }`. This plugin's
    // tool *is* named `mcp`, so it collides with that reserved name and gets the
    // envelope. Left wrapped, the gateway reads `tool: "mcp"` as a tool to call
    // on some server and answers `No known MCP tool named "mcp"` to every single
    // call — installed, listed, and completely unable to do anything.
    const text = await tool().call({ tool: PROXY_TOOL_NAME, args: { search: 'anything' } })
    assert.match(text, /nothing to search/)
    assert.doesNotMatch(text, /No known MCP tool/)
  })

  it('unwraps an empty envelope into the status listing', async () => {
    const text = await tool().call({ tool: PROXY_TOOL_NAME, args: {} })
    assert.match(text, /No MCP servers are configured/)
  })

  it('leaves a real tool call alone', async () => {
    // `tool: "some_tool"` is a caller asking an MCP server for that tool. Only
    // this gateway's own name marks the envelope, and a server cannot offer a
    // tool called `mcp` — this gateway is the only one.
    const text = await tool().call({ tool: 'some_tool', args: { a: 1 } })
    assert.match(text, /No known MCP tool named "some_tool"/)
  })

  it('leaves a malformed envelope to the schema rather than guessing', async () => {
    // `args` that is not an object is not the shape the host sends. The tool's
    // own schema already rejects it — `args` is declared as an object — so the
    // unwrapper only has to decline, and the caller gets a named violation
    // instead of a silently different call.
    await assert.rejects(
      tool().call({ tool: PROXY_TOOL_NAME, args: 'not-an-object' }),
      /"args" must be an object/,
    )
  })

  it('does not mutate the caller’s argument object', async () => {
    const args: Record<string, unknown> = { tool: PROXY_TOOL_NAME, args: { search: 'x' } }
    const before = JSON.stringify(args)
    await tool().call(args)
    assert.equal(JSON.stringify(args), before)
  })
})
