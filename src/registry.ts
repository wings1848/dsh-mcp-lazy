/**
 * The gateway registry: one view over every configured server's tools,
 * regardless of whether that server is connected, disconnected, or disabled.
 *
 * The registry answers `search`, `describe`, and `status` from the metadata
 * cache alone — no connection, no child process. Only `invoke`, `connect`, and
 * `instructions` reach the live {@link GatewayConnection}, and the registry
 * caches whatever a live fetch returns so the next `search` stays offline.
 *
 * @module dsh-mcp-lazy/registry
 */

import {
  buildCacheEntry,
  CACHE_VERSION,
  computeConfigHash,
  loadMetadataCache,
  metadataCachePath,
  saveMetadataCache,
} from './metadata-cache.js'
import { isToolAllowed, matchesNamePattern, qualifiedToolName, toolCandidates } from './naming.js'
import {
  buildToolDocument,
  paginate,
  rankSuggestions,
  rankToolMatches,
  regexToolMatches,
  type RankedToolMatch,
  type ToolDocument,
} from './search-ranking.js'
import {
  DEFAULT_CACHE_MAX_AGE_MS,
  DEFAULT_IDLE_TIMEOUT_MINUTES,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
} from './schema.js'
import type {
  Config,
  ToolCallResult,
  MetadataCache,
  ServerCacheEntry,
  ServerEntry,
  ServerLifecycle,
  ServerStatus,
  ToolMetadata,
} from './types.js'

/**
 * How long a server that failed to start is left alone, in milliseconds.
 *
 * Without a window, one broken server is re-spawned and re-timed-out on every
 * call that mentions one of its tools — the cost lands on every request, and
 * the same failure is rediscovered each time.
 */
export const FAILURE_BACKOFF_MS = 60_000

/**
 * What a canceled call is told when it never reached the connection layer.
 *
 * Deliberately the same sentence the connection layer produces for the same
 * condition, so a caller that cancels reads one wording whether or not the
 * attempt had already started — and so {@link McpGatewayRegistry} recognises
 * both as a cancellation rather than a server failure.
 */
const CANCELED_BEFORE_CONNECT = 'the tool call was canceled before the server connected'

/** What a live synchronous fetch from one connected server returns. */
export interface LiveToolCatalog {
  tools: ToolMetadata[]
  instructions?: string
}

/**
 * The live half of the gateway, implemented by the connection layer.
 *
 * The registry depends on this narrow interface rather than on transports: it
 * needs "give me this server's catalog" and "call this tool", and nothing about
 * how either is achieved.
 */
export interface GatewayConnection {
  /** Ensure one server is connected, fetching its catalog. */
  connect: (entry: ServerEntry, signal?: AbortSignal) => Promise<LiveToolCatalog>
  /** Call one tool on an already-connected server. */
  invokeTool: (
    entry: ServerEntry,
    tool: ToolMetadata,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<ToolCallResult>
  /** Close one server's connection, if any. */
  disconnect: (serverName: string) => Promise<void>
  /** Whether a server currently holds a live connection. */
  isConnected: (serverName: string) => boolean
  /** Close every connection. */
  dispose: () => Promise<void>
  /**
   * Last failure the connection layer saw per server, when it keeps one.
   *
   * Optional for the same reason as {@link GatewayConnection.onCatalogChanged}:
   * a minimal layer may not track failures. The registry reports its own errors
   * first and falls back to this, so a failure that never passed through a
   * connect attempt — a tool-list refresh whose listener threw, say — still
   * reaches `status` instead of dying in a private map nothing reads.
   */
  errors?: ReadonlyMap<string, string>
  /**
   * Observe a server's live tool-list changes.
   *
   * Optional so a minimal embedded layer can omit it; the registry asks for it
   * through {@link McpGatewayRegistry.bindLiveCatalogRefresh} and degrades to
   * "the catalog only changes when something connects".
   */
  onCatalogChanged?: (listener: (serverName: string, catalog: LiveToolCatalog) => void) => void
}

/** How one tool's live call failed, when that is useful to the model. */
export interface DeferredInvoke {
  /** Tool name as the caller wrote it. */
  requested: string
  /** Arguments the caller passed. */
  args: Record<string, unknown>
}

/** One search result, already projected for output. */
export interface SearchMatch {
  server: string
  tool: string
  originalName: string
  description: string
  /** Compact `name (type)` parameter list, when requested and known. */
  parameters?: string
  score: number
}

/** The full outcome of one `search` call. */
export interface SearchOutcome {
  query: string
  matches: SearchMatch[]
  total: number
  offset: number
  hasMore: boolean
  nextOffset: number | null
  /** Servers whose catalogs are known only from cache, so results may be stale. */
  cachedServers: string[]
  /** True when nothing matched anywhere and no cache exists to search. */
  coldCache: boolean
  /**
   * Set when the search itself was rejected — currently only an unusable regular
   * expression. `matches` is empty by construction, and the message is written
   * to be shown to the model verbatim rather than reported as "no matches".
   */
  error?: string
}

/** A resolved invocation target. */
export interface InvokeTarget {
  entry: ServerEntry
  tool: ToolMetadata
}

/** How resolving a tool name failed. */
export type InvokeResolution =
  | { kind: 'ok'; target: InvokeTarget }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'unknown'; suggestions: string[] }
  | { kind: 'disabled'; entry: ServerEntry }

/** Compact parameter summary derived from an advertised JSON schema. */
export function summarizeParameters(schema: unknown): string | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined
  const properties = (schema as { properties?: unknown }).properties
  if (typeof properties !== 'object' || properties === null) return undefined
  const required = new Set(
    Array.isArray((schema as { required?: unknown }).required)
      ? ((schema as { required: unknown[] }).required).filter((item): item is string => typeof item === 'string')
      : [],
  )
  const parts: string[] = []
  for (const [name, raw] of Object.entries(properties as Record<string, unknown>)) {
    let type = 'any'
    if (typeof raw === 'object' && raw !== null) {
      const node = raw as { type?: unknown; enum?: unknown }
      if (typeof node.type === 'string') type = node.type
      else if (Array.isArray(node.enum) && node.enum.length > 0) {
        type = node.enum.map(value => JSON.stringify(value)).join('|')
      }
    }
    parts.push(`${name}${required.has(name) ? '' : '?'}: ${type}`)
  }
  return parts.length > 0 ? parts.join(', ') : undefined
}

/** Resolved per-server settings after defaults are applied. */
interface ResolvedServer {
  entry: ServerEntry
  lifecycle: ServerLifecycle
  /** Idle window in milliseconds; `0` means "never reap". */
  idleTimeoutMs: number
}

/**
 * Resolve the lifecycle and idle window for one entry.
 *
 * Every mode except `lazy` means "keep this process", so it defaults to no
 * reaping at all and only `lazy` inherits the global window. An explicit
 * `idleTimeout`, `0` included, always wins.
 *
 * `pi-mcp-adapter` reaches the same outcome by two routes: it zeroes the window
 * for `eager` and `lazy-keep-alive`, and its idle sweep skips any server in its
 * keep-alive set — which is exactly the `keep-alive` mode. This plugin has no
 * separate keep-alive set, so `keep-alive` is zeroed here instead. Folding it in
 * rather than adding a second mechanism keeps one rule in one place; the
 * observable behaviour matches pi either way.
 *
 * @param entry - The configured server entry.
 * @param globalIdleMinutes - The plugin-level idle window in minutes.
 * @returns The resolved settings.
 */
export function resolveServer(entry: ServerEntry, globalIdleMinutes: number): ResolvedServer {
  const lifecycle: ServerLifecycle = entry.lifecycle ?? 'lazy'
  const reaps = lifecycle === 'lazy'
  const idleMinutes = entry.idleTimeout ?? (reaps ? globalIdleMinutes : 0)
  return { entry, lifecycle, idleTimeoutMs: Math.max(0, idleMinutes) * 60_000 }
}

/** One catalog known to the registry, with its provenance. */
interface KnownCatalog {
  tools: ToolMetadata[]
  instructions?: string
  fromCache: boolean
  cachedAt?: number
}

/** The gateway registry. */
export class McpGatewayRegistry {
  readonly #servers: ResolvedServer[]
  readonly #byName = new Map<string, ResolvedServer>()
  readonly #known = new Map<string, KnownCatalog>()
  readonly #documents = new Map<string, ToolDocument[]>()
  readonly #errors = new Map<string, string>()
  /** When each server last failed to start, for the retry backoff. */
  readonly #failedAt = new Map<string, number>()
  /**
   * Servers whose catalog this session fetched itself.
   *
   * Their in-memory entry is newer than anything on disk by construction, so
   * they are the ones a write-back is allowed to overwrite.
   */
  readonly #writtenServers = new Set<string>()
  readonly #failureBackoffMs: number
  /** Plugin-level `directTools`, used when a server does not set its own. */
  readonly #globalDirectTools: boolean | 'search' | undefined
  #connection: GatewayConnection | undefined
  #cache: MetadataCache

  /**
   * @param config - Resolved plugin configuration.
   * @param connection - Live connection layer; omitted before M2, in which case
   *   only cache-backed operations work.
   */
  constructor(config: Config, connection?: GatewayConnection) {
    this.#connection = connection
    const globalIdle = config.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_MINUTES
    this.#servers = config.servers.map(entry => resolveServer(entry, globalIdle))
    this.#failureBackoffMs = Math.max(0, config.failureBackoffMs ?? FAILURE_BACKOFF_MS)
    this.#globalDirectTools = config.directTools

    const duplicates: string[] = []
    for (const server of this.#servers) {
      if (this.#byName.has(server.entry.serverName)) duplicates.push(server.entry.serverName)
      this.#byName.set(server.entry.serverName, server)
    }
    if (duplicates.length > 0) {
      throw new Error(
        `mcp-lazy: duplicate serverName ${[...new Set(duplicates)].map(name => `"${name}"`).join(', ')} — every server needs a unique name`,
      )
    }

    this.#cache = loadMetadataCache() ?? { version: CACHE_VERSION, servers: {} }
    this.#hydrateFromCache()
  }

  /** Absolute path of the metadata cache, for status output and diagnostics. */
  get cachePath(): string {
    return metadataCachePath()
  }

  /** Replace the live connection layer (used once M2 wires it in). */
  setConnection(connection: GatewayConnection): void {
    this.#connection = connection
  }

  /** Every configured server, in configuration order. */
  get servers(): readonly ServerEntry[] {
    return this.#servers.map(server => server.entry)
  }

  /**
   * Servers whose configuration asks to be connected during activation.
   *
   * `eager` and `keep-alive` mean "resident from the start", and `pi-mcp-adapter`
   * connects exactly this pair at init. The two differ only in whether the
   * lifecycle manager also health-checks them; both resolve to no idle reaping.
   *
   * The default mode is `lazy`, so a default configuration yields an empty list
   * and activation still spawns nothing — which is the point of the plugin. This
   * is empty-in-the-common-case on purpose, not by accident.
   *
   * Disabled servers are excluded: they are configured but must not be started.
   */
  residentServers(): ServerEntry[] {
    return this.#servers
      .filter(server =>
        server.entry.disabled !== true
        && (server.lifecycle === 'eager' || server.lifecycle === 'keep-alive'))
      .map(server => server.entry)
  }

  /**
   * Load cache-backed catalogs into the known map on construction.
   *
   * A stale entry is still loaded when its config hash still matches — a
   * catalog that is merely old is far more useful than no catalog at all — but
   * it is marked `fromCache` so status and search can say so.
   */
  #hydrateFromCache(): void {
    const now = Date.now()
    for (const server of this.#servers) {
      const cached = this.#cache.servers[server.entry.serverName]
      if (cached === undefined) continue
      // Defence in depth. `loadMetadataCache` already refuses an entry whose
      // tool list is not an array, and this runs during construction — where a
      // throw is the plugin load failing, not one server going cold.
      if (!Array.isArray(cached.tools)) continue
      if (cached.configHash !== computeConfigHash(server.entry)) continue
      const age = now - cached.cachedAt
      if (!Number.isFinite(age) || age > DEFAULT_CACHE_MAX_AGE_MS) continue
      const tools = this.#filterTools(server.entry, cached.tools)
      this.#known.set(server.entry.serverName, {
        tools,
        ...(cached.instructions !== undefined ? { instructions: cached.instructions } : {}),
        fromCache: true,
        cachedAt: cached.cachedAt,
      })
    }
    this.#rebuildDocuments()
  }

  /**
   * Recompute qualified names for a catalog.
   *
   * Names are recomputed rather than trusted from the cache so a change to the
   * naming contract can never resurrect an old name from disk.
   *
   * @param entry - The server entry.
   * @param tools - Raw tools, from cache or a live fetch.
   * @returns The same tools carrying current names.
   */
  #nameTools(entry: ServerEntry, tools: readonly ToolMetadata[]): ToolMetadata[] {
    return tools.map(tool => ({
      ...tool,
      qualifiedName: qualifiedToolName(entry.serverName, tool.originalName),
    }))
  }

  /**
   * Apply the entry's include/exclude filters on top of fresh names.
   *
   * Filtering happens **only on the way out** — never on the way into the
   * cache. `includeTools`/`excludeTools` are presentation settings, so the
   * cached catalog has to stay the server's full tool list. Caching the
   * filtered set makes a filter impossible to loosen: re-filtering an
   * already-filtered list can only ever remove more, so a tool dropped by a
   * since-removed `excludeTools` entry could never come back. `configHash`
   * deliberately ignores these fields for the same reason, which is also why
   * the two decisions must stay together.
   *
   * @param entry - The server entry.
   * @param tools - Raw tools, from cache or a live fetch.
   * @returns The surviving tools with current names.
   */
  #filterTools(entry: ServerEntry, tools: readonly ToolMetadata[]): ToolMetadata[] {
    return this.#nameTools(entry, tools).filter(tool => isToolAllowed(tool, entry))
  }

  /** Rebuild the search documents for every known catalog. */
  #rebuildDocuments(): void {
    this.#documents.clear()
    for (const server of this.#servers) {
      const known = this.#known.get(server.entry.serverName)
      if (known === undefined) continue
      this.#documents.set(
        server.entry.serverName,
        known.tools.map(tool => buildToolDocument(server.entry.serverName, tool, server.entry)),
      )
    }
  }

  /** Every searchable document across all known catalogs. */
  #allDocuments(): ToolDocument[] {
    const out: ToolDocument[] = []
    for (const server of this.#servers) out.push(...(this.#documents.get(server.entry.serverName) ?? []))
    return out
  }

  /** Record a live catalog and persist it to the metadata cache. */
  #recordLive(server: ResolvedServer, catalog: LiveToolCatalog): void {
    const named = this.#nameTools(server.entry, catalog.tools)
    const tools = named.filter(tool => isToolAllowed(tool, server.entry))
    this.#known.set(server.entry.serverName, {
      tools,
      ...(catalog.instructions !== undefined ? { instructions: catalog.instructions } : {}),
      fromCache: false,
      cachedAt: Date.now(),
    })
    this.#errors.delete(server.entry.serverName)
    this.#failedAt.delete(server.entry.serverName)
    // The cache receives the *unfiltered* list on purpose — see `#filterTools`.
    // Filtering on the way in would bake today's include/exclude into disk state
    // that `configHash` cannot invalidate.
    this.#cache.servers[server.entry.serverName] = buildCacheEntry(
      server.entry,
      named,
      catalog.instructions,
    )
    this.#writtenServers.add(server.entry.serverName)
    this.#persistCache()
    this.#rebuildDocuments()
  }

  /**
   * Write this session's catalogs into the cache without discarding anyone else's.
   *
   * The one file is shared by every DSH process pointed at the same `$DSH_HOME`
   * — a GUI and a CLI, or two `--profile` runs — so writing back the snapshot
   * this registry read at construction would delete whatever the other process
   * learned in the meantime, and search would keep degrading to a cold cache for
   * servers that had already been discovered.
   *
   * "Anyone else's" is a claim about the ordinary case, not a guarantee: the
   * read-modify-write below takes no lock, so two processes writing at the same
   * instant can still lose each other's newest entries. Measured with two real
   * processes writing 40 servers each: 45 of 80 entries survived. A lost entry
   * costs one reconnect and a cold search for that server, never a wrong answer,
   * which is why this is not locked — the file is a cache, and a lock here would
   * put a shared filesystem in the way of every tool call.
   *
   * Filtering the file against this configuration does not repair that: a profile
   * is a process-local view and the cache path carries no profile segment, so a
   * server this process does not know is far more likely to be another profile's
   * server than a deleted one. The only entries removed here are the ones every
   * reader already ignores — those past the age bound — which is also what keeps
   * the file from growing forever once a server really is deleted.
   *
   * A file written by a future `CACHE_VERSION` is read as "no cache" and then
   * rewritten in this version's shape, so an older build can replace a newer
   * file rather than merge with it. That is the pre-existing version-gate
   * behavior, not something the merge introduced.
   *
   * The on-disk shape is unchanged — same version, same entry fields — so an
   * older build reads whatever this writes.
   */
  #persistCache(): void {
    const now = Date.now()
    const merged: Record<string, ServerCacheEntry> = {}
    for (const [name, entry] of Object.entries(loadMetadataCache()?.servers ?? {})) {
      if (now - entry.cachedAt > DEFAULT_CACHE_MAX_AGE_MS) continue
      merged[name] = entry
    }
    // A server this session fetched always wins over the disk copy: the disk
    // copy is either older or was written by a process that saw a stale catalog.
    for (const name of this.#writtenServers) {
      const own = this.#cache.servers[name]
      if (own !== undefined) merged[name] = own
    }
    const next: MetadataCache = { version: CACHE_VERSION, servers: merged }
    saveMetadataCache(next)
    this.#cache = next
  }

  /**
   * Search every known catalog.
   *
   * @param query - Query text, or a regular expression when `regex` is set.
   * @param options - Paging, schema inclusion, and regex mode.
   * @returns The ranked, paged outcome.
   */
  search(
    query: string,
    options: { regex?: boolean; includeSchemas?: boolean; limit?: number; offset?: number } = {},
  ): SearchOutcome {
    const documents = this.#allDocuments()
    let ranked: RankedToolMatch[]
    if (options.regex === true) {
      const result = regexToolMatches(documents, query)
      if ('error' in result) {
        return {
          query,
          matches: [],
          total: 0,
          offset: 0,
          hasMore: false,
          nextOffset: null,
          cachedServers: this.#cachedServerNames(),
          coldCache: documents.length === 0,
          error: result.error,
        }
      }
      ranked = result.matches
    } else {
      ranked = rankToolMatches(documents, query)
    }

    const includeSchemas = options.includeSchemas !== false
    const limit = Math.min(Math.max(1, options.limit ?? SEARCH_DEFAULT_LIMIT), SEARCH_MAX_LIMIT)
    const offset = Math.max(0, options.offset ?? 0)
    const page = paginate(ranked, offset, limit)

    return {
      query,
      matches: page.items.map(match => {
        const summary = includeSchemas ? summarizeParameters(match.tool.inputSchema) : undefined
        return {
          server: match.serverName,
          tool: match.tool.qualifiedName,
          originalName: match.tool.originalName,
          description: match.tool.description,
          ...(summary !== undefined ? { parameters: summary } : {}),
          score: match.score,
        }
      }),
      total: page.total,
      offset,
      hasMore: page.hasMore,
      nextOffset: page.nextOffset,
      cachedServers: this.#cachedServerNames(),
      coldCache: documents.length === 0,
    }
  }

  /** Names of the servers whose catalogs came from disk rather than a live call. */
  #cachedServerNames(): string[] {
    const out: string[] = []
    for (const server of this.#servers) {
      if (this.#known.get(server.entry.serverName)?.fromCache === true) out.push(server.entry.serverName)
    }
    return out
  }

  /**
   * Find every known tool matching a name, by qualified name, original name, or
   * `server:tool` / `server/tool` / `server__tool` spellings.
   *
   * @param name - The name as written by the caller.
   * @param serverName - Optional server hint that disambiguates.
   * @returns The matching tools with their servers.
   */
  #findMatches(name: string, serverName?: string): InvokeTarget[] {
    const trimmed = name.trim()
    const out: InvokeTarget[] = []
    const candidates = this.#servers.filter(
      server => serverName === undefined || server.entry.serverName === serverName,
    )
    for (const server of candidates) {
      const known = this.#known.get(server.entry.serverName)
      if (known === undefined) continue
      for (const tool of known.tools) {
        const qualifiedTail = tool.qualifiedName.slice(server.entry.serverName.length + 2)
        if (
          tool.qualifiedName === trimmed ||
          tool.originalName === trimmed ||
          qualifiedTail === trimmed ||
          `${server.entry.serverName}:${tool.originalName}` === trimmed ||
          `${server.entry.serverName}/${tool.originalName}` === trimmed
        ) {
          out.push({ entry: server.entry, tool })
        }
      }
    }
    return out
  }

  /**
   * Resolve a tool name to exactly one live target.
   *
   * Ambiguity is reported rather than guessed at: two servers may legitimately
   * both expose `search`, and picking one silently would be worse than asking.
   *
   * @param requested - Tool name as written by the caller.
   * @param serverName - Optional server hint.
   * @returns The resolution outcome.
   */
  resolveInvoke(requested: string, serverName?: string): InvokeResolution {
    const matches = this.#findMatches(requested, serverName)
    if (matches.length === 1) return { kind: 'ok', target: matches[0]! }
    if (matches.length > 1) {
      return {
        kind: 'ambiguous',
        candidates: matches.map(match => `${match.entry.serverName}:${match.tool.originalName}`),
      }
    }
    if (serverName !== undefined) {
      const server = this.#byName.get(serverName)
      if (server?.entry.disabled === true) return { kind: 'disabled', entry: server.entry }
    }
    return { kind: 'unknown', suggestions: rankSuggestions(this.#allDocuments(), requested) }
  }

  /**
   * Describe one tool from the known catalogs.
   *
   * @param requested - Tool name as written by the caller.
   * @param serverName - Optional server hint.
   * @returns The resolution, whose target carries the full input schema.
   */
  describe(requested: string, serverName?: string): InvokeResolution {
    return this.resolveInvoke(requested, serverName)
  }

  /**
   * Ensure a server's catalog is live, fetching it when the connection layer is
   * available and remembering the result.
   *
   * @param entry - The server entry to connect.
   * @param signal - Cancellation signal from the tool call.
   * @returns The live catalog.
   */
  async ensureConnected(
    entry: ServerEntry,
    signal?: AbortSignal,
    options: { force?: boolean } = {},
  ): Promise<LiveToolCatalog> {
    if (entry.disabled === true) {
      throw new Error(`mcp-lazy: server "${entry.serverName}" is disabled in configuration`)
    }
    const connection = this.#connection
    if (connection === undefined) {
      throw new Error(
        `mcp-lazy: the connection layer is not available in this build, so server "${entry.serverName}" cannot be started`,
      )
    }
    const server = this.#byName.get(entry.serverName)
    if (server === undefined) {
      throw new Error(`mcp-lazy: server "${entry.serverName}" is not configured`)
    }
    // A call that was canceled before it got here has nobody left to receive the
    // catalog. Connecting anyway would spawn a process for a caller that is
    // already gone — and connecting is exactly what the rest of this method does.
    if (signal?.aborted === true) throw new Error(CANCELED_BEFORE_CONNECT)
    // A server that just failed is left alone for a while. Without this, a
    // broken server is re-spawned and re-timed-out on every single call that
    // mentions one of its tools. An explicit `connect` overrides it, so fixing
    // the configuration does not mean waiting out the window.
    if (options.force !== true) {
      const refused = this.#backoffReason(entry.serverName)
      if (refused !== undefined) throw new Error(refused)
    }
    try {
      const catalog = await connection.connect(entry, signal)
      this.#recordLive(server, catalog)
      return catalog
    } catch (error) {
      // A cancellation says nothing about the server, so it must not open the
      // retry window: the next caller — who did not cancel anything — would be
      // refused for a minute over a decision the previous caller made on
      // purpose. The rejection still propagates, so the caller sees why.
      if (this.#isCancellation(error, signal)) throw error
      const message = error instanceof Error ? error.message : String(error)
      this.#errors.set(entry.serverName, message)
      this.#failedAt.set(entry.serverName, Date.now())
      throw error
    }
  }

  /**
   * Whether a failed `connect` was really the caller walking away.
   *
   * The signal is the authority: the connection layer releases a canceled caller
   * immediately while the shared attempt keeps running, so by the time the
   * rejection arrives that caller's signal is aborted by definition. The message
   * is a second signal for a layer that produces the cancellation without the
   * abort reaching this far, and it cannot mask a real failure — no transport
   * produces that sentence on its own.
   *
   * The signal test over-approximates on purpose. A caller who cancels at the
   * same moment the server genuinely fails is read as a cancellation, so that
   * failure is neither reported in `status` nor given a backoff window. The cost
   * is one extra attempt against a server that is already broken; reading it the
   * other way round would refuse a caller who did nothing wrong, for a minute,
   * which is the bug this exists to fix.
   *
   * @param error - What the connection layer rejected with.
   * @param signal - The signal the call was made under, when it had one.
   * @returns Whether this was a cancellation rather than a failure.
   */
  #isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
    if (signal?.aborted === true) return true
    return error instanceof Error && error.message === CANCELED_BEFORE_CONNECT
  }

  /**
   * Why a server is currently being left alone, if it is.
   *
   * @param serverName - The server to check.
   * @returns The refusal message, or `undefined` when a retry is allowed.
   */
  #backoffReason(serverName: string): string | undefined {
    const failedAt = this.#failedAt.get(serverName)
    if (failedAt === undefined) return undefined
    const age = Math.max(0, Date.now() - failedAt)
    if (age >= this.#failureBackoffMs) {
      this.#failedAt.delete(serverName)
      return undefined
    }
    const seconds = Math.max(1, Math.round(age / 1000))
    const remaining = Math.max(1, Math.ceil((this.#failureBackoffMs - age) / 1000))
    const detail = this.#errors.get(serverName) ?? 'unknown error'
    return (
      `mcp-lazy: server "${serverName}" failed ${seconds}s ago and is not retried automatically ` +
      `for another ${remaining}s: ${detail}`
    )
  }

  /**
   * Call one tool, connecting its server first when necessary.
   *
   * @param target - The resolved server and tool.
   * @param args - Arguments exactly as the caller supplied them.
   * @param signal - Cancellation signal from the tool call.
   * @returns The live MCP result value.
   */
  async invoke(
    target: InvokeTarget,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolCallResult> {
    const connection = this.#requireConnection()
    if (!connection.isConnected(target.entry.serverName)) {
      await this.ensureConnected(target.entry, signal)
    }
    return connection.invokeTool(target.entry, target.tool, args, signal)
  }

  /** The live layer, or a diagnostic explaining its absence. */
  #requireConnection(): GatewayConnection {
    const connection = this.#connection
    if (connection === undefined) {
      throw new Error('mcp-lazy: the connection layer is not available in this build')
    }
    return connection
  }

  /**
   * Find a tool by connecting servers whose catalogs are not yet known.
   *
   * This is what makes a cold start work. Nothing is known about a server until
   * something needs it, so the first call for a tool has to go looking: catalogs
   * already in hand are consulted first (they are free), then each remaining
   * server is connected in configuration order until the name resolves. A server
   * that cannot start is skipped with its error recorded rather than aborting the
   * search — one broken server must not make every other server unreachable, and
   * its diagnostic still surfaces in status.
   *
   * @param requested - Tool name as written by the caller.
   * @param serverName - Optional server hint, which restricts the search.
   * @param signal - Cancellation signal from the tool call.
   * @returns The resolution after discovery, plus what was tried.
   */
  async discoverAndResolve(
    requested: string,
    serverName: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ resolution: InvokeResolution; attempted: string[]; failures: string[] }> {
    const attempted: string[] = []
    const failures: string[] = []

    const immediate = this.resolveInvoke(requested, serverName)
    if (immediate.kind === 'ok' || immediate.kind === 'ambiguous' || immediate.kind === 'disabled') {
      return { resolution: immediate, attempted, failures }
    }

    for (const server of this.#servers) {
      if (serverName !== undefined && server.entry.serverName !== serverName) continue
      if (server.entry.disabled === true) continue
      if (this.#known.has(server.entry.serverName)) continue

      attempted.push(server.entry.serverName)
      try {
        await this.ensureConnected(server.entry, signal)
      } catch (error) {
        failures.push(
          `${server.entry.serverName}: ${error instanceof Error ? error.message : String(error)}`,
        )
        continue
      }

      const resolution = this.resolveInvoke(requested, serverName)
      if (resolution.kind === 'ok' || resolution.kind === 'ambiguous') {
        return { resolution, attempted, failures }
      }
    }

    return { resolution: this.resolveInvoke(requested, serverName), attempted, failures }
  }

  /** The server's published instructions, from a live connection or the cache. */
  instructions(serverName: string): string | undefined {
    return this.#known.get(serverName)?.instructions
  }

  /**
   * The known tools for one server, in catalog order.
   *
   * @param serverName - The server name.
   * @returns Its tools, or an empty array when nothing is known yet.
   */
  toolsOf(serverName: string): ToolMetadata[] {
    return this.#known.get(serverName)?.tools ?? []
  }

  /** Whether a catalog is known for one server. */
  hasCatalog(serverName: string): boolean {
    return this.#known.get(serverName) !== undefined
  }

  /** Cache-backed entry for one server, when the hash still matches. */
  cachedEntry(serverName: string): ServerCacheEntry | undefined {
    return this.#cache.servers[serverName]
  }

  /** Per-server status, read without touching the network. */
  status(): ServerStatus[] {
    return this.#servers.map(server => {
      const known = this.#known.get(server.entry.serverName)
      const connected = this.#connection?.isConnected(server.entry.serverName) ?? false
      const error =
        this.#errors.get(server.entry.serverName) ??
        this.#connection?.errors?.get(server.entry.serverName)
      const status: ServerStatus = {
        serverName: server.entry.serverName,
        state: server.entry.disabled === true ? 'disconnected' : connected ? 'connected' : error !== undefined ? 'failed' : 'disconnected',
        lifecycle: server.lifecycle,
        disabled: server.entry.disabled === true,
        toolCount: known?.tools.length ?? 0,
        fromCache: known?.fromCache ?? false,
        connected,
      }
      if (known?.cachedAt !== undefined) {
        status.cachedAgeSeconds = Math.max(0, Math.round((Date.now() - known.cachedAt) / 1000))
      }
      const failedAt = this.#failedAt.get(server.entry.serverName)
      if (failedAt !== undefined) {
        status.failedAgoSeconds = Math.max(0, Math.round((Date.now() - failedAt) / 1000))
      }
      if (error !== undefined) status.lastError = error
      return status
    })
  }

  /**
   * Whether `directTools` would make this gateway register a server's tools itself.
   *
   * Asked while advising a user to bring a natively-served server here, so it reads
   * the setting that server would serve under rather than what is registered right
   * now: a disabled entry promotes nothing at the moment — {@link directToolSelections}
   * skips it — but clearing that flag is what the advice says to do, and then it
   * would. Computed from the configuration alone, not from the catalogs, so the
   * answer does not change after a first connect.
   *
   * `'search'` is deliberately not counted. It stages tools until a search matches
   * one, which is the deferred form of promotion rather than a blanket
   * registration, and those servers are reported separately by
   * {@link searchModeServers}.
   *
   * A server that is not configured here still answers from the plugin-level
   * default, because that is the setting an arrival would inherit.
   *
   * @param serverName - The namespace to ask about, configured here or not.
   * @returns True when promotion would apply to it in this gateway.
   */
  promotesNatively(serverName: string): boolean {
    const setting = this.#byName.get(serverName)?.entry.directTools ?? this.#globalDirectTools
    return setting === true || (Array.isArray(setting) && setting.length > 0)
  }

  /**
   * Tools that should be promoted out of the proxy into native tools.
   *
   * Native promotion is the one thing that can move the model-facing surface, so
   * it is opt-in per server and computed from configuration plus whatever the
   * catalogs currently say. `'search'` returns nothing here: those tools are
   * staged as inactive by {@link stageDirectTools} and only become real once a
   * search actually matches them.
   *
   * @returns One selection per server that asked for promotion.
   */
  directToolSelections(): { serverName: string; tools: ToolMetadata[]; mode: 'all' | 'named' }[] {
    const out: { serverName: string; tools: ToolMetadata[]; mode: 'all' | 'named' }[] = []
    for (const server of this.#servers) {
      // A disabled entry refuses to connect, so promoting its tools would put tools
      // in every request whose calls can only fail — `ensureConnected` rejects a
      // disabled entry outright. Promotion is about the model-facing surface, and
      // `disabled` means "kept visible in status, never served".
      if (server.entry.disabled === true) continue
      const setting = server.entry.directTools ?? this.#globalDirectTools
      if (setting === undefined || setting === false || setting === 'search') continue
      const known = this.#known.get(server.entry.serverName)
      if (known === undefined) continue
      const tools =
        setting === true
          ? known.tools
          : known.tools.filter(tool =>
              setting.some(pattern => toolCandidates(tool).some(name => matchesNamePattern(pattern, name))),
            )
      if (tools.length === 0) continue
      out.push({ serverName: server.entry.serverName, tools, mode: setting === true ? 'all' : 'named' })
    }
    return out
  }

  /**
   * Servers configured for `directTools: 'search'`.
   *
   * Their tools stay in the cache and behind the proxy until a search matches
   * one, which is what keeps the request prefix untouched for a session that
   * never goes looking.
   *
   * @returns The server names in search mode.
   */
  searchModeServers(): string[] {
    return this.#servers
      .filter(server => server.entry.disabled !== true)
      .filter(server => (server.entry.directTools ?? this.#globalDirectTools) === 'search')
      .map(server => server.entry.serverName)
  }

  /**
   * Tools a search just matched, for activation in `'search'` mode.
   *
   * @param query - The query the model ran.
   * @param options - Regex mode, so activation matches what was displayed.
   * @returns The matched tools, with their owning entries.
   */
  matchesForActivation(
    query: string,
    options: { regex?: boolean } = {},
  ): { entry: ServerEntry; tool: ToolMetadata }[] {
    const searchable = new Set(this.searchModeServers())
    if (searchable.size === 0) return []
    const out: { entry: ServerEntry; tool: ToolMetadata }[] = []
    for (const server of this.#servers) {
      if (!searchable.has(server.entry.serverName)) continue
      const documents = this.#documents.get(server.entry.serverName) ?? []
      let ranked: RankedToolMatch[]
      if (options.regex === true) {
        // Activation must mirror what the search displayed, including its
        // refusal to guess at an invalid pattern.
        const result = regexToolMatches(documents, query)
        ranked = 'error' in result ? [] : result.matches
      } else {
        ranked = rankToolMatches(documents, query)
      }
      for (const match of ranked) out.push({ entry: server.entry, tool: match.tool })
    }
    return out
  }

  /**
   * Subscribe to live catalog refreshes.
   *
   * Ownership matters here: a gateway that is told to stay in sync but was never
   * wired to the signal would silently serve a stale catalog, so the registry
   * owns the subscription and the plugin entry only has to ask for it once.
   */
  bindLiveCatalogRefresh(onChange?: () => void): void {
    this.#connection?.onCatalogChanged?.((serverName, catalog) => {
      this.recordRefreshedCatalog(serverName, catalog)
      onChange?.()
    })
  }

  /**
   * Accept a catalog a live connection refreshed on its own.
   *
   * Wired to the connection layer's tool-list-changed signal: the server pushed
   * a new list, so the known catalog and the disk cache are both updated. The
   * proxy tool's own schema is untouched, which is what keeps the request prefix
   * stable across a refresh.
   *
   * @param serverName - The server that changed.
   * @param catalog - Its refreshed catalog.
   */
  recordRefreshedCatalog(serverName: string, catalog: LiveToolCatalog): void {
    const server = this.#byName.get(serverName)
    if (server === undefined) return
    this.#recordLive(server, catalog)
  }

  /** Close every connection and release the live layer. */
  async dispose(): Promise<void> {
    await this.#connection?.dispose()
  }
}
