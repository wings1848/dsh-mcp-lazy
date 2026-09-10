/**
 * dsh-mcp-lazy — a lazy MCP gateway for DeepSeek Harness.
 *
 * Registers exactly one model-facing tool (`mcp`) for every configured MCP
 * server, discovers tool metadata into a disk cache, and starts a server only
 * when a tool call actually needs it. See `docs/design/plan.md` for the acceptance criteria.
 *
 * @module dsh-mcp-lazy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LazyConnections } from './connection.js'
import { DirectToolRegistrar } from './direct-tools.js'
import { qualifiedToolName } from './naming.js'
import { OutputGuard } from './output-guard.js'
import { createProxyTool } from './proxy-tool.js'
import { McpGatewayRegistry, resolveServer } from './registry.js'
import {
  DEFAULT_IDLE_TIMEOUT_MINUTES,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  PROXY_TOOL_NAME,
} from './schema.js'
import type { Config as ConfigShape, OutputGuardConfig } from './types.js'
import { SERVER_NAME_PATTERN } from './types.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-lazy'

/** Services this plugin consumes: it registers tools and nothing else. */
export const inject = ['tools']

/** Accepted lifecycle modes, in the order the config catalog lists them. */
const LIFECYCLES = ['lazy', 'lazy-keep-alive', 'eager', 'keep-alive'] as const

const ServerSchema = z.object({
  serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
  transport: z.union([z.const('stdio'), z.const('streamable-http')]).required(),
  command: z.string(),
  args: z.array(String).default([]),
  env: z.dict(String).default({}),
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
  }
}

/**
 * Register the gateway.
 *
 * Activation is synchronous and performs no I/O: no server is contacted, no
 * child process is spawned, and the model-facing tool is registered before the
 * first turn. Everything expensive happens on first use.
 *
 * @param ctx - Plugin context carrying the tool registry.
 * @param config - Resolved gateway configuration.
 */
export function apply(ctx: Context, config: ConfigShape): void {
  // A resolved config always carries both fields, but this entry is also called
  // directly by tests and by SDK users, so a partial object must not crash the
  // host's plugin load.
  const resolved: ConfigShape = {
    idleTimeout: config?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_MINUTES,
    servers: Array.isArray(config?.servers) ? config.servers : [],
    freezeDirectTools: config?.freezeDirectTools === true,
    outputGuard: config?.outputGuard ?? true,
    ...(typeof config?.idleWindowMs === 'function' ? { idleWindowMs: config.idleWindowMs } : {}),
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

  ctx.tools.register(
    createProxyTool(
      registry,
      (query, options) => direct.activateFromSearch(query, options),
      outputGuard,
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

  ctx.effect(
    () => () => {
      activation.abort()
      direct.dispose()
      void registry.dispose()
      void outputGuard.dispose()
    },
    `mcp-lazy.dispose(${PROXY_TOOL_NAME})`,
  )
}

export { LazyConnections, McpGatewayRegistry, createProxyTool, PROXY_TOOL_NAME, OutputGuard }

// The exported `Config` is both the schemastery schema (a value) and, through
// declaration merging, the resolved configuration type.
