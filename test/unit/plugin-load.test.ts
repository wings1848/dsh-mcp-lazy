/**
 * The cordis plugin contract.
 *
 * A plugin that type-checks but cannot be loaded is worthless, so this suite
 * exercises the exact surface the harness loader uses: the named exports, the
 * schemastery config schema, and `apply(ctx, config)` registering the tool on a
 * context whose only members are `tools.register` and `effect`.
 *
 * It also asserts the load is *silent*: activation must not spawn, connect, or
 * read the network, because that is the whole reason this plugin exists.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../helpers/tmp.ts'
import { Config, apply, inject, name } from '../../lib/index.js'
import { PROXY_TOOL_NAME } from '../../lib/schema.js'
import type { Config as ConfigShape } from '../../lib/types.js'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

const here = dirname(fileURLToPath(import.meta.url))
const originalHome = process.env['DSH_HOME']

before(() => {
  process.env['DSH_HOME'] = tempDir('dsh-mcp-lazy-load-')
})

after(() => {
  if (originalHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = originalHome
})

/** What `apply` is allowed to touch on the context. */
interface FakeContext {
  tools: { register: (definition: ToolDefinition) => () => void }
  effect: (callback: () => (() => void | Promise<void>), label?: string) => void
}

/**
 * Build a context that records what the plugin registered.
 *
 * `effect` keeps every disposer rather than discarding it, which is how the
 * unload path gets exercised: the host calls those on scope teardown, and a
 * plugin that leaks a tool or a process there would be a real defect.
 *
 * `register` returns a real unregister function and `disposeAll` does not touch
 * the `registered` list. Both matter: the harness's `register` returns the exact
 * disposer that removes the tool, and an earlier version of this fake cleared the
 * list itself, which made every "no tool may outlive the plugin scope" assertion
 * pass no matter what the plugin did.
 */
function fakeContext(): {
  ctx: FakeContext
  registered: ToolDefinition[]
  effects: string[]
  disposeAll: () => void | Promise<void>
} {
  const registered: ToolDefinition[] = []
  const effects: string[] = []
  const disposers: (() => void | Promise<void>)[] = []
  const ctx: FakeContext = {
    tools: {
      register: definition => {
        registered.push(definition)
        return () => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    effect: (callback, label) => {
      effects.push(label ?? '(unlabeled)')
      disposers.push(callback())
    },
  }
  return {
    ctx,
    registered,
    effects,
    disposeAll: async () => {
      for (const dispose of disposers) await dispose()
    },
  }
}

/** A minimal resolved config, as schemastery would hand it to `apply`. */
function resolved(servers: ConfigShape['servers'] = []): ConfigShape {
  return { idleTimeout: 10, servers }
}

describe('plugin exports', () => {
  it('exports the loader contract', () => {
    assert.equal(name, 'mcp-lazy')
    assert.deepEqual(inject, ['tools'])
    assert.equal(typeof apply, 'function')
    assert.equal(typeof Config, 'function')
  })

  it('accepts an empty server list', () => {
    const { ctx, registered, effects } = fakeContext()
    assert.doesNotThrow(() => apply(ctx as never, resolved()))
    assert.equal(registered.length, 1)
    assert.deepEqual(effects, [`mcp-lazy.dispose(${PROXY_TOOL_NAME})`])
  })

  it('registers exactly one tool, built by defineTool', () => {
    const { ctx, registered } = fakeContext()
    apply(
      ctx as never,
      resolved([{ serverName: 'demo', transport: 'stdio', command: 'demo-server' }]),
    )
    assert.equal(registered.length, 1)
    const tool = registered[0]!
    assert.equal(tool.name, PROXY_TOOL_NAME)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(tool.output.schema.type, 'string')
  })

  it('registers the same tool schema regardless of configured servers', () => {
    const one = fakeContext()
    apply(one.ctx as never, resolved([{ serverName: 'a', transport: 'stdio', command: 'x' }]))
    const many = fakeContext()
    apply(
      many.ctx as never,
      resolved([
        { serverName: 'a', transport: 'stdio', command: 'x' },
        { serverName: 'b', transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp' },
        { serverName: 'c', transport: 'stdio', command: 'y', disabled: true, includeTools: ['t'] },
      ]),
    )
    assert.equal(
      JSON.stringify(one.registered[0]!.parameters),
      JSON.stringify(many.registered[0]!.parameters),
    )
    assert.equal(one.registered[0]!.description, many.registered[0]!.description)
  })
})

describe('configuration validation at load time', () => {
  it('rejects a stdio server with no command', () => {
    const { ctx } = fakeContext()
    assert.throws(
      () => apply(ctx as never, resolved([{ serverName: 'broken', transport: 'stdio' }])),
      /uses transport stdio but has no command/,
    )
  })

  it('rejects an http server with no url', () => {
    const { ctx } = fakeContext()
    assert.throws(
      () => apply(ctx as never, resolved([{ serverName: 'broken', transport: 'streamable-http' }])),
      /uses transport streamable-http but has no url/,
    )
  })

  it('rejects duplicate server names', () => {
    const { ctx } = fakeContext()
    assert.throws(
      () =>
        apply(
          ctx as never,
          resolved([
            { serverName: 'dup', transport: 'stdio', command: 'x' },
            { serverName: 'dup', transport: 'stdio', command: 'y' },
          ]),
        ),
      /duplicate serverName "dup"/,
    )
  })

  it('rejects a field it does not implement instead of ignoring it', () => {
    // A config carried over from @deepseek-ai/dsh-mcp-client can legitimately
    // contain `reconnect` or `failOnStartupError`. schemastery passes unknown
    // keys straight through, so without a check they land in the resolved
    // config, nothing ever reads them, and the setting silently does nothing --
    // the exact failure this project keeps having to fix.
    const { ctx, registered } = fakeContext()
    assert.throws(
      () =>
        apply(
          ctx as never,
          resolved([
            {
              serverName: 'ported',
              transport: 'stdio',
              command: 'node',
              reconnect: { maxAttempts: 3 },
            } as never,
          ]),
        ),
      /reconnect/,
    )
    // A rejection must not leave a half-registered plugin behind.
    assert.equal(registered.length, 0)
  })

  it('names a misspelled field rather than accepting it', () => {
    const { ctx } = fakeContext()
    assert.throws(
      () =>
        apply(
          ctx as never,
          resolved([
            { serverName: 'typo', transport: 'stdio', command: 'node', idleTimout: 5 } as never,
          ]),
        ),
      /idleTimout/,
    )
  })

  it('rejects an unknown field at the plugin level too', () => {
    // The server-level check does not see this, and schemastery passes unknown
    // top-level keys through just the same. A typo here is otherwise silent.
    const { ctx } = fakeContext()
    assert.throws(
      () => apply(ctx as never, { idleTimeout: 10, servers: [], idleTimout: 5 } as never),
      /idleTimout/,
    )
  })

  it('accepts every field it claims to support', () => {
    // Guards KNOWN_SERVER_FIELDS against drifting away from ServerSchema. A
    // field added to the schema but not to the whitelist would be rejected by
    // the check above, and nothing else in the suite would notice.
    const { ctx, registered } = fakeContext()
    assert.doesNotThrow(() =>
      apply(
        ctx as never,
        resolved([
          {
            serverName: 'everything',
            transport: 'stdio',
            command: 'node',
            args: ['a'],
            env: { K: 'v' },
            cwd: '/tmp',
            url: 'http://127.0.0.1:1/mcp',
            headers: { H: 'v' },
            toolCallTimeoutMs: 1000,
            lifecycle: 'eager',
            idleTimeout: 5,
            directTools: true,
            includeTools: ['echo*'],
            excludeTools: ['never'],
            searchKeywords: { echo: ['kw'] },
            disabled: false,
            debug: true,
          },
        ]),
      ),
    )
    assert.equal(registered.length, 1)
  })

  it('does not register anything when configuration is rejected', () => {
    const { ctx, registered } = fakeContext()
    assert.throws(() => apply(ctx as never, resolved([{ serverName: 'x', transport: 'stdio' }])))
    assert.equal(registered.length, 0)
  })

  it('survives a config object with no fields at all', () => {
    const { ctx, registered } = fakeContext()
    assert.doesNotThrow(() => apply(ctx as never, {} as ConfigShape))
    assert.equal(registered.length, 1)
  })

  it('accepts every outputGuard spelling', () => {
    for (const outputGuard of [true, false, { enabled: false }, { maxBytes: 1024, maxLines: 10 }]) {
      const { ctx, registered } = fakeContext()
      assert.doesNotThrow(
        () => apply(ctx as never, { idleTimeout: 10, servers: [], outputGuard } as ConfigShape),
        `outputGuard ${JSON.stringify(outputGuard)} should load`,
      )
      assert.equal(registered.length, 1)
    }
  })

  it('registers the same tool definition whatever the outputGuard is', () => {
    // The guard bounds results, never the tool surface: if it changed the
    // schema it would move the request prefix, which is the one thing this
    // plugin exists to keep still.
    const bare = fakeContext()
    apply(bare.ctx as never, { idleTimeout: 10, servers: [] } as ConfigShape)
    const guarded = fakeContext()
    apply(
      guarded.ctx as never,
      { idleTimeout: 10, servers: [], outputGuard: { maxBytes: 8, maxLines: 1 } } as ConfigShape,
    )

    assert.deepEqual(
      JSON.stringify(guarded.registered[0]?.parameters),
      JSON.stringify(bare.registered[0]?.parameters),
    )
  })
})

describe('AC1 — activation is silent', () => {
  it('performs no I/O, so it works with PATH replaced by a spawn trap', async () => {
    const originalPath = process.env['PATH']
    process.env['PATH'] = '/nonexistent'
    try {
      const { ctx, registered } = fakeContext()
      apply(
        ctx as never,
        resolved([
          { serverName: 'never-started', transport: 'stdio', command: 'definitely-not-real' },
          { serverName: 'never-fetched', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' },
        ]),
      )
      assert.equal(registered.length, 1)

      // The registered tool must still answer status without connecting.
      const value = await registered[0]!.execute({}, {
        signal: new AbortController().signal,
      } as never)
      assert.match(String(value), /2 MCP servers configured/)
      assert.match(String(value), /never-started/)
    } finally {
      process.env['PATH'] = originalPath
    }
  })
})

describe('AC16 — the plugin unloads cleanly', () => {
  it('releases its tool and stops its connections on scope teardown', async () => {
    const { entry, counterFile } = (() => {
      const counter = join(process.env['DSH_HOME']!, 'unload.starts')
      return {
        entry: {
          serverName: 'unload',
          transport: 'stdio' as const,
          command: process.execPath,
          args: [join(here, '..', 'fixtures', 'mcp-server.mjs')],
          env: { FIXTURE_START_COUNT: counter },
          toolCallTimeoutMs: 5000,
        },
        counterFile: counter,
      }
    })()

    const { ctx, registered, disposeAll } = fakeContext()
    apply(ctx as never, resolved([entry]))
    assert.equal(registered.length, 1)

    // Start the server through the registered tool, so a process really exists.
    await registered[0]!.execute({ connect: 'unload' }, {
      signal: new AbortController().signal,
    } as never)
    assert.equal(
      readFileSync(counterFile, 'utf8').split('\n').filter(line => line !== '').length,
      1,
      'the connect action must have started the server',
    )

    // Teardown: the host calls the disposers, and nothing may survive them.
    await disposeAll()
    assert.equal(registered.length, 0, 'no tool may outlive the plugin scope')
    assert.equal(registered.some(tool => tool.name === PROXY_TOOL_NAME), false)
  })

  it('starts no process merely by being unloaded', async () => {
    const counter = join(process.env['DSH_HOME']!, 'unload-untouched.starts')
    const { ctx, registered, disposeAll } = fakeContext()
    apply(ctx as never, resolved([
      {
        serverName: 'untouched',
        transport: 'stdio',
        command: process.execPath,
        args: [join(here, '..', 'fixtures', 'mcp-server.mjs')],
        env: { FIXTURE_START_COUNT: counter },
      },
    ]))
    assert.equal(registered.length, 1)

    await disposeAll()
    let starts = 0
    try {
      starts = readFileSync(counter, 'utf8').split('\n').filter(line => line !== '').length
    } catch {
      starts = 0
    }
    assert.equal(starts, 0, 'load and unload alone must never spawn a server')
  })
})
