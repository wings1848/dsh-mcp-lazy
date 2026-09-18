/**
 * dsh-mcp-lazy — a lazy MCP gateway for DeepSeek Harness.
 *
 * Registers exactly one model-facing tool (`mcp`) for every configured MCP
 * server, discovers tool metadata into a disk cache, and starts a server only
 * when a tool call actually needs it. See `docs/design.md` for the invariants
 * this shape is built to hold.
 *
 * @module dsh-mcp-lazy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { registerAdoptCommand } from './command.js'
import { LazyConnections } from './connection.js'
import { DirectToolRegistrar } from './direct-tools.js'
import { DEFAULT_ENV_FROM_TIMEOUT_MS } from './env-from.js'
import { qualifiedToolName } from './naming.js'
import { OutputGuard } from './output-guard.js'
import { createProxyTool } from './proxy-tool.js'
import { McpGatewayRegistry, FAILURE_BACKOFF_MS, resolveServer } from './registry.js'
import {
  DEFAULT_IDLE_TIMEOUT_MINUTES,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  PROXY_TOOL_NAME,
} from './schema.js'
import type { Config as ConfigShape, OutputGuardConfig } from './types.js'
import { SERVER_NAME_PATTERN, UNNAMED_NATIVE_NAME } from './types.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-lazy'

/** Services this plugin consumes: it registers tools and nothing else. */
export const inject = ['tools']

/** Accepted lifecycle modes, in the order the config catalog lists them. */
const LIFECYCLES = ['lazy', 'lazy-keep-alive', 'eager', 'keep-alive'] as const

/**
 * Every field a server entry may carry, as a set.
 *
 * schemastery passes unknown keys through untouched, so this list is the only
 * thing standing between a typo and a setting that silently does nothing. It
 * has to be kept in step with `ServerSchema` below; `plugin-load.test.ts` fails
 * if the two drift apart.
 *
 * Exported because `adopt` has to answer the same question from outside — is
 * this row something this plugin can load? — and a second copy of the list would
 * be a second thing to keep in step.
 */
export const KNOWN_SERVER_FIELDS: ReadonlySet<string> = new Set([
  'serverName',
  'transport',
  'command',
  'args',
  'env',
  'envFrom',
  'allowEmpty',
  'envFromTimeoutMs',
  'cwd',
  'url',
  'headers',
  'toolCallTimeoutMs',
  'lifecycle',
  'idleTimeout',
  'directTools',
  'includeTools',
  'excludeTools',
  'searchKeywords',
  'disabled',
  'debug',
])

/** Plugin-level fields. Same job as `KNOWN_SERVER_FIELDS`, one level up. */
const KNOWN_PLUGIN_FIELDS: ReadonlySet<string> = new Set([
  'idleTimeout',
  'freezeDirectTools',
  'directTools',
  'outputGuard',
  'servers',
  'failureBackoffMs',
  // Deliberately absent from the schema below: supplied directly by tests and
  // SDK callers, never spelled in a config file. It is whitelisted so those
  // callers keep working, and validated by `assertPluginConfig` so a scalar
  // cannot pass silently.
  'idleWindowMs',
])

/**
 * Fields that belong to `@deepseek-ai/dsh-mcp-client`, with what to do instead.
 *
 * These are the ones a ported configuration is most likely to carry, and each
 * needs a different answer, so a generic "unknown field" message would leave the
 * reader to work it out. Silence is the one response that is never right: the
 * field would sit in the resolved config looking configured.
 *
 * Exported because `adopt` reports these as skip reasons, and the explanation it
 * prints has to be the same one `apply` throws.
 */
export const MCP_CLIENT_ONLY_FIELDS: ReadonlyMap<string, string> = new Map([
  [
    'reconnect',
    'dsh-mcp-lazy has no reconnect timer — a server that drops is restarted by the next call that needs it, and a server that fails to start is left alone for the failure-backoff window',
  ],
  [
    'failOnStartupError',
    'use lifecycle: "eager" with a server you require at startup, or leave it lazy and let the first call report the failure',
  ],
])

const ServerSchema = z.object({  serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
  transport: z.union([z.const('stdio'), z.const('streamable-http')]).required(),
  command: z.string(),
  args: z.array(String).default([]),
  env: z.dict(String).default({}),
  envFrom: z.dict(String).default({}),
  allowEmpty: z.array(String).default([]),
  envFromTimeoutMs: z.natural().default(DEFAULT_ENV_FROM_TIMEOUT_MS),
  cwd: z.string(),
  url: z.string(),
  headers: z.dict(String).default({}),
  toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  lifecycle: z.union(LIFECYCLES.map(mode => z.const(mode))).default('lazy'),
  idleTimeout: z.natural(),
  directTools: z.union([z.boolean(), z.array(String), z.const('search')]),
  includeTools: z.array(String),
  excludeTools: z.array(String),
  searchKeywords: z.dict(z.array(String)),
  disabled: z.boolean().default(false),
  debug: z.boolean().default(false),
})

/**
 * Resolved plugin configuration.
 *
 * `servers` is the only required field in spirit; an empty list is legal and
 * simply means the gateway has nothing to route to yet.
 */
export const Config: z<Partial<ConfigShape>, ConfigShape> = z.object({
  idleTimeout: z.natural().default(DEFAULT_IDLE_TIMEOUT_MINUTES),
  /**
   * Stop promoting `directTools` after the first sync.
   *
   * Promotion is the only thing that can move the model-facing tool surface.
   * Leaving this off means a server that keeps editing its catalog keeps
   * changing the request prefix; turning it on bounds that to one event.
   */
  freezeDirectTools: z.boolean().default(false),
  /**
   * Promotion default for every server. A server's own `directTools` wins.
   *
   * Exists because `pi-mcp-adapter` exposes the same thing as
   * `settings.directTools`, and because "expose everything natively" should not
   * require editing every server row.
   */
  directTools: z.union([z.boolean(), z.const('search')]).default(false),
  /**
   * Output bounding. `true` (the default) applies the built-in ceilings; `false`
   * returns oversized results verbatim; an object tunes them.
   */
  outputGuard: z
    .union([
      z.boolean(),
      z.object({
        enabled: z.boolean().default(true),
        maxBytes: z.natural(),
        maxLines: z.natural(),
      }),
    ])
    .default(true),
  /**
   * How long a server that failed to start is left alone, in milliseconds.
   *
   * Declared here rather than left to the registry's fallback: the registry has
   * always honoured it, but without a schema entry a config file carrying it
   * lost the value before `apply` ever saw it — the setting looked supported and
   * was silently dropped. `0` disables the window, so the next call retries.
   */
  failureBackoffMs: z.number().min(0).default(FAILURE_BACKOFF_MS),
  servers: z.array(ServerSchema).default([]),
})

/**
 * Reduce the accepted `outputGuard` spellings to one config object.
 *
 * @param value - Raw configuration value.
 * @returns The guard configuration.
 */
function resolveOutputGuard(value: ConfigShape['outputGuard']): OutputGuardConfig {
  if (value === undefined || value === true) return {}
  if (value === false) return { enabled: false }
  return {
    ...(value.enabled !== undefined ? { enabled: value.enabled } : {}),
    ...(value.maxBytes !== undefined ? { maxBytes: value.maxBytes } : {}),
    ...(value.maxLines !== undefined ? { maxLines: value.maxLines } : {}),
  }
}

/** The plugin this one is a drop-in replacement for. */
const NATIVE_MCP_PLUGIN = '@deepseek-ai/dsh-mcp-client'

/** The slice of a loader entry this plugin reads. */
interface LoaderEntry {
  disabled?: boolean
  options?: {
    name?: string
    disabled?: boolean
    config?: { serverName?: unknown }
  }
}

/**
 * Servers another mounted plugin is about to register as native tools.
 *
 * Those schemas enter every request as real tool definitions, which is the cost
 * this plugin exists to remove — so both plugins serving the same servers is a
 * configuration mistake worth naming. It is not a crash and not a name clash:
 * this plugin's tool is `mcp` and the other's are `mcp__<server>__<tool>`, so
 * nothing fails, the saving just quietly does not happen. That is exactly the
 * kind of thing the model should be able to tell the user about.
 *
 * The loader is read *without* injecting it. `ctx.get` is documented to read a
 * service "without the inject requirement" and to return `undefined` when it is
 * not provided, so running outside a cordis host — the tests, an SDK caller —
 * reports nothing rather than failing to load. That also means this cannot be
 * the reason a plugin fails.
 *
 * This reads the declared entry tree rather than runtime state, so it does not
 * depend on which plugin the loader happens to apply first.
 *
 * @param ctx - Plugin context.
 * @returns The `serverName` of each enabled entry, or an empty list.
 */
function detectNativelyRegistered(ctx: Context): string[] {
  const get = (ctx as { get?: (name: string) => unknown }).get
  if (typeof get !== 'function') return []

  let loader: unknown
  try {
    loader = get.call(ctx, 'loader')
  } catch {
    return []
  }

  const entries = (loader as { entries?: () => Iterable<unknown> } | undefined)?.entries
  if (typeof entries !== 'function') return []

  const names: string[] = []
  for (const raw of entries.call(loader) as Iterable<LoaderEntry>) {
    const options = raw?.options
    if (options?.name !== NATIVE_MCP_PLUGIN) continue
    if (raw.disabled === true || options.disabled === true) continue
    const serverName = options.config?.serverName
    // A `!!js` expression stays a raw node here: the loader evaluates it only for
    // the config it hands the plugin, so this reads an object where mcp-client
    // sees the evaluated name. The placeholder is what the listing reports on.
    names.push(
      typeof serverName === 'string' && serverName !== '' ? serverName : UNNAMED_NATIVE_NAME,
    )
  }
  return names
}

/**
 * Reject plugin-level fields the plugin will never read.
 *
 * The server-level check cannot see these, and schemastery passes unknown
 * top-level keys through exactly the same way — so a typo here, or a field
 * carried over from `pi-mcp-adapter`'s settings block, would be accepted and
 * then silently ignored.
 *
 * @param config - The raw configuration handed to `apply`.
 */
function assertPluginConfig(config: ConfigShape | undefined): void {
  if (config === undefined || config === null) return
  // Checked before the whitelist below, because `idleWindowMs` *is* whitelisted
  // and a scalar spelling of it used to sail straight through: the field is a
  // function seam, so `apply` dropped anything else on the floor and the caller
  // never learned the window was not applied.
  if ('idleWindowMs' in config && typeof config.idleWindowMs !== 'function') {
    throw new Error(
      'mcp-lazy: "idleWindowMs" only accepts a function — it resolves a server\'s idle ' +
        'window in milliseconds and is meant for tests and SDK callers. Set `idleTimeout` ' +
        '(minutes) instead, globally or per server.',
    )
  }
  for (const field of Object.keys(config)) {
    if (KNOWN_PLUGIN_FIELDS.has(field)) continue
    throw new Error(
      `mcp-lazy: unknown plugin-level field "${field}" — check the spelling. ` +
        `Known fields: ${[...KNOWN_PLUGIN_FIELDS].join(', ')}`,
    )
  }
}

/**
 * Reject entries that cannot possibly work.
 *
 * Done at load rather than at first call so a typo surfaces where it was made —
 * a config file — instead of in the middle of a turn. Nothing here connects.
 *
 * @param servers - The configured server entries.
 */
function assertServerConfig(servers: ConfigShape['servers'] | undefined): void {
  if (!Array.isArray(servers)) return
  const seen = new Set<string>()
  for (const entry of servers) {
    if (seen.has(entry.serverName)) {
      throw new Error(
        `mcp-lazy: duplicate serverName "${entry.serverName}" — every server needs a unique name`,
      )
    }
    seen.add(entry.serverName)

    // Reject anything the plugin will not read. schemastery hands unknown keys
    // through, so a field carried over from dsh-mcp-client, or a typo, would
    // otherwise be accepted and then ignored — indistinguishable from configured.
    for (const field of Object.keys(entry)) {
      if (KNOWN_SERVER_FIELDS.has(field)) continue
      const instead = MCP_CLIENT_ONLY_FIELDS.get(field)
      throw new Error(
        instead === undefined
          ? `mcp-lazy: server "${entry.serverName}" has an unknown field "${field}" — ` +
            `check the spelling. Known fields: ${[...KNOWN_SERVER_FIELDS].join(', ')}`
          : `mcp-lazy: server "${entry.serverName}" sets "${field}", which belongs to ` +
            `@deepseek-ai/dsh-mcp-client and is not implemented here — ${instead}`,
      )
    }

    if (entry.transport === 'stdio' && (entry.command === undefined || entry.command === '')) {
      throw new Error(
        `mcp-lazy: server "${entry.serverName}" uses transport stdio but has no command`,
      )
    }
    if (entry.transport === 'streamable-http' && (entry.url === undefined || entry.url === '')) {
      throw new Error(
        `mcp-lazy: server "${entry.serverName}" uses transport streamable-http but has no url`,
      )
    }

    assertEnvFrom(entry)
  }
}

/**
 * Reject `envFrom` declarations that cannot mean what they say.
 *
 * All four are configuration mistakes with silent or delayed consequences:
 * a name in both `env` and `envFrom` would be resolved twice and only one of
 * them would win, an `envFrom` on a transport that never spawns would simply
 * never run, and an `allowEmpty` entry that names nothing looks like a
 * permission that is not one.
 *
 * @param entry - One configured server entry.
 */
function assertEnvFrom(entry: ConfigShape['servers'][number]): void {
  const declared = Object.keys(entry.envFrom ?? {})

  if (entry.transport !== 'stdio' && declared.length > 0) {
    throw new Error(
      `mcp-lazy: server "${entry.serverName}" sets envFrom on transport ${entry.transport}, ` +
        'which never spawns a process — envFrom only applies to stdio servers',
    )
  }

  for (const name of declared) {
    if (Object.hasOwn(entry.env ?? {}, name)) {
      throw new Error(
        `mcp-lazy: server "${entry.serverName}" resolves "${name}" from both env and envFrom — ` +
          'keep one: env for a literal, envFrom for a command',
      )
    }
    if ((entry.envFrom ?? {})[name] === '') {
      throw new Error(
        `mcp-lazy: server "${entry.serverName}" gives envFrom "${name}" an empty command`,
      )
    }
  }

  for (const name of entry.allowEmpty ?? []) {
    if (!declared.includes(name)) {
      throw new Error(
        `mcp-lazy: server "${entry.serverName}" lists "${name}" in allowEmpty, but envFrom ` +
          'does not declare it — allowEmpty only names envFrom variables',
      )
    }
  }
}

/**
 * Register the gateway.
 *
 * Activation spawns nothing for a default configuration and never touches the
 * network: the model-facing tool is registered before the first turn, and
 * everything expensive happens on first use. The one thing it does read is the
 * on-disk metadata cache, synchronously, so that `search` and `describe` can
 * answer immediately. Only servers explicitly configured `eager` or `keep-alive`
 * are contacted here, and those connects are fire-and-forget.
 *
 * @param ctx - Plugin context carrying the tool registry.
 * @param config - Resolved gateway configuration.
 */
export function apply(ctx: Context, config: ConfigShape): void {
  assertPluginConfig(config)
  // A resolved config always carries both fields, but this entry is also called
  // directly by tests and by SDK users, so a partial object must not crash the
  // host's plugin load.
  const resolved: ConfigShape = {
    idleTimeout: config?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_MINUTES,
    servers: Array.isArray(config?.servers) ? config.servers : [],
    freezeDirectTools: config?.freezeDirectTools === true,
    outputGuard: config?.outputGuard ?? true,
    ...(config?.directTools === undefined ? {} : { directTools: config.directTools }),
    ...(typeof config?.idleWindowMs === 'function' ? { idleWindowMs: config.idleWindowMs } : {}),
    // The schema supplies the default; this entry point is also called directly
    // with a hand-built config, so the fallback stays.
    failureBackoffMs: config?.failureBackoffMs ?? FAILURE_BACKOFF_MS,
  }
  assertServerConfig(resolved.servers)

  // Bounds every server-authored payload. Constructing it touches no disk; a
  // spill directory only appears once something is actually truncated.
  const outputGuard = new OutputGuard(resolveOutputGuard(resolved.outputGuard))

  // The live half. Constructing it opens no socket and spawns no child: it
  // installs one unref'd sweep timer so idle servers can be reaped later.
  const idleWindow = (entry: ConfigShape['servers'][number]): number => {
    if (resolved.idleWindowMs !== undefined) return resolved.idleWindowMs(entry)
    const globalIdle = resolved.idleTimeout
    return resolveServer(entry, globalIdle).idleTimeoutMs
  }
  const connections = new LazyConnections(idleWindow)
  connections.setQualifier(qualifiedToolName)

  const registry = new McpGatewayRegistry(resolved, connections)

  // Optional native promotion. Off unless configured: `register` is the same
  // registry the proxy lives in, so a promoted tool is a real tool.
  const direct = new DirectToolRegistrar(
    registry,
    definition => ctx.tools.register(definition),
    resolved.freezeDirectTools === true,
    outputGuard,
  )

  // A server that changes its tool list mid-session refreshes the known catalog
  // and the cache. Promotion is re-evaluated from that fresh catalog, which is
  // why the registrar — not the connection layer — owns the sync.
  registry.bindLiveCatalogRefresh(() => {
    direct.sync()
  })
  direct.sync()

  // The disposer is kept, not discarded. `register` returns the exact function
  // that unregisters the tool and it is not fiber-scoped — the harness's own
  // mcp-client keeps and calls the ones it gets — so dropping it would leave a
  // stale `mcp` tool behind after an HMR unload, pointing at a registry whose
  // connection layer is already disposed.
  const unregisterProxy = ctx.tools.register(
    createProxyTool(
      registry,
      (query, options) => direct.activateFromSearch(query, options),
      outputGuard,
      // A getter, not a snapshot. The loader re-runs the entries whose own config
      // changed, and a co-mounted `dsh-mcp-client` row edited in *another* layer
      // leaves this plugin's config untouched — so a value read here would keep
      // reporting the old tree. Reading it per status render costs one tree walk
      // and cannot go stale.
      () => detectNativelyRegistered(ctx),
    ),
  )

  // `eager` and `keep-alive` mean "resident from activation", and pi-mcp-adapter
  // connects exactly that pair at init. Without this loop both modes would
  // behave like their lazy counterparts — a documented setting that silently
  // does nothing.
  //
  // A default configuration is all-`lazy`, so this list is empty and activation
  // still spawns nothing. That is the reason the plugin exists, and it stays
  // true. Registration happens first so a slow server cannot delay the
  // model-facing tool surface.
  //
  // Failures are not propagated: an unreachable server must not fail plugin
  // load. `ensureConnected` records the failure for the retry backoff and for
  // status output, which is where it belongs. The controller ties in-flight
  // connects to the plugin's lifetime, so unloading does not leave a spawn
  // racing the teardown.
  const activation = new AbortController()
  for (const entry of registry.residentServers()) {
    void registry.ensureConnected(entry, activation.signal).catch(() => {})
  }

  // The human half: `/mcp-adopt`, so the move `renderStatus` reports as needed
  // can be made without leaving the GUI. It is reached through `ctx.inject`,
  // never through this plugin's own `inject` list — waiting for a command
  // registry would leave the model-facing tool unregistered on any composition
  // that has none, which is the one regression this plugin must never ship.
  registerAdoptCommand(ctx)

  ctx.effect(
    () => () => {
      // Order matters only in that the tool must stop being callable before the
      // registry behind it is torn down.
      unregisterProxy()
      activation.abort()
      direct.dispose()
      // Awaited, not fired and forgotten: cordis waits for an async disposer,
      // and returning before the children are closed and the spill directories
      // removed would let an unload-then-reload race its own predecessor.
      return Promise.all([registry.dispose(), outputGuard.dispose()]).then(() => undefined)
    },
    `mcp-lazy.dispose(${PROXY_TOOL_NAME})`,
  )
}

export { LazyConnections, McpGatewayRegistry, createProxyTool, PROXY_TOOL_NAME, OutputGuard }

// The exported `Config` is both the schemastery schema (a value) and, through
// declaration merging, the resolved configuration type.
