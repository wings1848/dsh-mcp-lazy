/**
 * Connection-layer hygiene: the client version, abort-listener bookkeeping, and
 * the plugin-level whitelist.
 *
 * Every case here is a regression for something the suite could not see. The
 * client version was a literal that had already drifted two releases behind the
 * package; the abort listener was registered `once` and never removed, so a
 * long-lived signal accumulated one per attempt; and a plugin-level field that
 * only accepts a function accepted a scalar and then threw it away.
 *
 * The library is imported from `lib/`, exactly as the rest of the suite does, so
 * a `src/` edit that was never built fails here rather than passing silently.
 */

import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { tempDir } from '../helpers/tmp.ts'
import { CLIENT_VERSION, LazyConnections } from '../../lib/connection.js'
import { Config, apply } from '../../lib/index.js'
import { qualifiedToolName } from '../../lib/naming.js'
import { FAILURE_BACKOFF_MS, McpGatewayRegistry, resolveServer } from '../../lib/registry.js'
import type {
  Config as ConfigShape,
  ServerEntry,
  ToolCallResult,
} from '../../lib/types.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..', '..')
const originalHome = process.env['DSH_HOME']

let workdir: string

/** Every connection layer built by a test, disposed so no child outlives a run. */
const layers: LazyConnections[] = []

before(() => {
  workdir = tempDir('dsh-mcp-lazy-hygiene-')
  process.env['DSH_HOME'] = join(workdir, 'home')
})

after(async () => {
  await Promise.all(layers.map(layer => layer.dispose().catch(() => undefined)))
  if (originalHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = originalHome
})

/**
 * Build a connection layer wired to a registry, as `apply` wires them.
 *
 * @param servers - The server entries to configure.
 * @param config - Extra plugin-level configuration.
 * @returns The layer and its registry.
 */
function gateway(
  servers: ServerEntry[],
  config: Partial<ConfigShape> = {},
): { connections: LazyConnections; registry: McpGatewayRegistry } {
  const connections = new LazyConnections(() => 600_000, { startSweeper: false })
  layers.push(connections)
  connections.setQualifier(qualifiedToolName)
  const registry = new McpGatewayRegistry(
    { idleTimeout: 10, servers, ...config },
    connections,
  )
  registry.bindLiveCatalogRefresh()
  return { connections, registry }
}

/**
 * A stdio entry whose command cannot be spawned, so connecting fails promptly.
 *
 * Deliberately not the fixture with `FIXTURE_FAIL`: this has to fail fast enough
 * that a listener-count test can afford one attempt per server.
 *
 * @param serverName - The server's name.
 * @returns The failing entry.
 */
function unreachableServer(serverName: string): ServerEntry {
  return {
    serverName,
    transport: 'stdio',
    command: join(workdir, 'no-such-executable-4f2a'),
  }
}

/** Call one tool through the registry, connecting its server first. */
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

/** Run `apply` against a context whose only member is `tools.register`. */
function fakeContext(): { registered: unknown[]; ctx: unknown } {
  const registered: unknown[] = []
  const ctx = {
    tools: {
      register: (definition: unknown) => {
        registered.push(definition)
        return () => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    effect: () => undefined,
    inject: () => undefined,
  }
  return { registered, ctx }
}

describe('the advertised client version', () => {
  it('matches package.json instead of a hand-written literal', () => {
    // The literal this replaced read `0.1.0` while the package was `0.3.0`, so
    // every server the gateway spoke to was told the wrong version. Reading the
    // manifest at load time is the only spelling that cannot drift; this asserts
    // the read actually landed rather than falling back to the unknown sentinel.
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      version: string
    }
    assert.equal(CLIENT_VERSION, manifest.version)
  })

  it('is what the built client is constructed with', () => {
    // Guards the second half of the invariant: `CLIENT_VERSION` could be right
    // while `#open` still passes its own literal to the SDK. Asserted on `lib/`
    // because that is the artifact the host loads.
    const built = readFileSync(join(packageRoot, 'lib', 'connection.js'), 'utf8')
    assert.match(built, /CLIENT_VERSION/)
    assert.doesNotMatch(built, /version:\s*'\d+\.\d+\.\d+'/)
  })
})

describe('abort listeners do not accumulate on a reused signal', () => {
  it('removes the listener once the shared attempt settles', async () => {
    // A shared attempt means one `connect` per server, but the caller's signal
    // is the same object every time. `{ once: true }` only fires the listener
    // on abort; it does not remove it when the attempt finishes first, so the
    // old code left one closure per attempt pinned to the signal, each one
    // holding an unsettled promise. Thirteen unreachable servers were enough to
    // show it, and none of it produced a MaxListeners warning.
    const servers = ['a', 'b', 'c', 'd'].map(unreachableServer)
    const { registry } = gateway(servers)
    const controller = new AbortController()
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)

    for (const entry of servers) {
      await assert.rejects(() =>
        registry.ensureConnected(entry, controller.signal, { force: true }),
      )
    }

    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    // The signal must not have been the thing that ended the attempts.
    assert.equal(controller.signal.aborted, false)
  })

  it('still cancels a caller that aborts before the attempt settles', async () => {
    // The cleanup must not break the one case the listener exists for.
    const entry = unreachableServer('aborted')
    const { registry } = gateway([entry])
    const controller = new AbortController()
    const pending = registry.ensureConnected(entry, controller.signal, { force: true })
    controller.abort()
    await assert.rejects(pending, /canceled before the server connected|no-such-executable/)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  })

  it('registers nothing when the signal is already aborted', async () => {
    const entry = unreachableServer('pre-aborted')
    const { registry } = gateway([entry])
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(() => registry.ensureConnected(entry, controller.signal, { force: true }))
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  })
})

describe('plugin-level configuration', () => {
  it('keeps the whitelist in step with the schema', () => {
    // A field added to `KNOWN_PLUGIN_FIELDS` with no schema entry is accepted
    // and then silently dropped — the failure this whitelist exists to catch.
    // `idleWindowMs` is the one deliberate exception: a function seam for tests
    // and SDK callers that no config file can address, so `assertPluginConfig`
    // validates it by hand instead.
    const source = readFileSync(join(packageRoot, 'src', 'index.ts'), 'utf8')
    const block = /KNOWN_PLUGIN_FIELDS[^=]*=\s*new Set\(\[([^\]]*)\]/.exec(source)
    assert.ok(block !== null, 'KNOWN_PLUGIN_FIELDS must stay a literal Set')
    const fields = [...block[1]!.matchAll(/'([^']+)'/g)].map(match => match[1]!)
    const schemaOnly = Config({ servers: [] }) as unknown as Record<string, unknown>

    assert.ok(fields.includes('failureBackoffMs'), 'failureBackoffMs must stay whitelisted')
    for (const field of fields) {
      if (field === 'idleWindowMs') continue
      assert.ok(field in schemaOnly, `${field} is whitelisted but the schema drops it`)
    }
    // The exception has to keep its hand-written guard: without one it is
    // accepted by the whitelist and then ignored by `apply`.
    assert.match(source, /idleWindowMs[\s\S]{0,200}typeof config\.idleWindowMs !== 'function'/)
  })

  it('lets failureBackoffMs through the schema and carries it to the registry', () => {
    // It was read from the resolved config and honoured by the registry, but it
    // was not in the schema, so a config file carrying it lost the value before
    // `apply` ever saw it.
    const parsed = Config({ servers: [], failureBackoffMs: 250 }) as ConfigShape
    assert.equal(parsed.failureBackoffMs, 250)
    assert.equal(Config({ servers: [] }).failureBackoffMs, FAILURE_BACKOFF_MS)

    const { ctx, registered } = fakeContext()
    assert.doesNotThrow(() => apply(ctx as never, parsed))
    assert.equal(registered.length, 1)
  })

  it('applies the configured failure backoff to the retry window', async () => {
    // The observable form of "it is a real setting": a zero window means the
    // very next call retries, a long one means it is refused with the remaining
    // time in the message.
    const retries = unreachableServer('retries')
    const patient = gateway([retries])
    await assert.rejects(() =>
      patient.registry.ensureConnected(retries, undefined, { force: true }),
    )
    await assert.rejects(
      () => patient.registry.ensureConnected(retries),
      /not retried automatically for another/,
    )

    const impatient = gateway([unreachableServer('impatient')], { failureBackoffMs: 0 })
    const quick = impatient.registry.status()[0]!.serverName
    const entry = { ...unreachableServer(quick), serverName: quick }
    await assert.rejects(() =>
      impatient.registry.ensureConnected(entry, undefined, { force: true }),
    )
    await assert.rejects(() => impatient.registry.ensureConnected(entry))
  })

  it('rejects a scalar idleWindowMs instead of ignoring it', () => {
    // It is a test/SDK seam, not a user setting, so it stays off the schema —
    // but a scalar passed here used to sail through validation and then be
    // dropped by the `typeof === 'function'` guard, which is exactly the
    // "accepted yet ignored" failure the whitelist is supposed to prevent.
    const { ctx } = fakeContext()
    assert.throws(
      () => apply(ctx as never, { idleTimeout: 10, servers: [], idleWindowMs: 5000 } as never),
      /idleWindowMs.*function/s,
    )

    // The function form is the whole point of the field and must keep working.
    const ok = fakeContext()
    const windowFor = (entry: ServerEntry): number => (entry.debug === true ? 1 : 2)
    assert.doesNotThrow(() =>
      apply(
        ok.ctx as never,
        { idleTimeout: 10, servers: [], idleWindowMs: windowFor } as never,
      ),
    )
    assert.equal(ok.registered.length, 1)
  })

  it('leaves the server-level idle window alone', () => {
    // The global function seam must not shadow a per-server `idleTimeout`.
    const entry: ServerEntry = { serverName: 's', transport: 'stdio', command: 'x', idleTimeout: 3 }
    assert.equal(resolveServer(entry, 10).idleTimeoutMs, 3 * 60_000)
  })
})

describe('a catalog-changed callback that throws', () => {
  it('is recorded rather than swallowed', async () => {
    // `apply` hangs native promotion off this callback, so its failure used to
    // disappear into the same `catch` that intentionally keeps the previous
    // catalog. The refresh failing and the callback failing are different
    // events and only the first one is allowed to be silent.
    const fixture = join(here, '..', 'fixtures', 'mcp-server.mjs')
    const entry: ServerEntry = {
      serverName: 'notify-hygiene',
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      toolCallTimeoutMs: 5000,
    }
    const { connections, registry } = gateway([entry])
    const failure = new Error('catalog-changed callback exploded 7c1d')
    connections.onCatalogChanged(() => {
      throw failure
    })

    await registry.ensureConnected(entry)
    const added = await call(registry, 'add_tool', { name: 'hygiene_dynamic' })
    assert.equal(added.isError, false)

    // The notification the fixture pushes when it gains a tool is asynchronous,
    // so poll for the record rather than assuming a tick count.
    const deadline = Date.now() + 5000
    while (connections.errors.get(entry.serverName) === undefined && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }

    assert.equal(connections.errors.get(entry.serverName), failure.message)
  })
})
