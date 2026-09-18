/**
 * Configuration shape for the lazy MCP gateway.
 *
 * One plugin row owns every server: `config.servers` is the list, `serverName`
 * is the namespace inside it. Transport fields keep the exact meaning they have
 * in `@deepseek-ai/dsh-mcp-client` so existing rows move over unchanged; the
 * lazy-specific fields (`lifecycle`, `idleTimeout`, `directTools`,
 * `includeTools`, `excludeTools`, `searchKeywords`, `disabled`) are new.
 *
 * @module dsh-mcp-lazy/types
 */

/** Namespace pattern for one server; mirrors the DSH mcp-client contract. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Stands in for a natively-enabled entry whose `serverName` is not a plain
 * string, so no name can be reported for it.
 *
 * `detectNativelyRegistered` substitutes this. The status listing does not read
 * the constant back: it treats *every* string the pattern above rejects the same
 * way, so a substituted placeholder, a literal spelling of this one, and a name
 * that is merely invalid — blank, or past the length limit — all end up in one
 * notice. The pattern rejects this string, so no *legal* name can equal it, and
 * mcp-client's own Config rejects it as well.
 *
 * Because those three are one list after the fact, the notice claims
 * *matchability* rather than absence: "has no `serverName`" would be false of the
 * literal spelling, while "no `serverName` this gateway can match" is true of all
 * three.
 */
export const UNNAMED_NATIVE_NAME = '(unnamed)'

/**
 * When a server's process may exist.
 *
 * "Connect during activation" means the plugin contacts the server while it is
 * being applied, before any tool call. Only these two modes spawn anything at
 * activation; a default (all-`lazy`) configuration spawns nothing.
 *
 * - `lazy` (default): connect on first use, reap when idle.
 * - `lazy-keep-alive`: connect on first use, then never reap.
 * - `eager`: connect during activation, then never reap.
 * - `keep-alive`: connect during activation and never reap.
 *
 * `eager` and `keep-alive` currently differ only in intent — both resolve to no
 * reaping. They are kept separate because pi-mcp-adapter defines both and a
 * configuration carried over from it must keep working.
 */
export type ServerLifecycle = 'lazy' | 'lazy-keep-alive' | 'eager' | 'keep-alive'

/**
 * Whether a server's tools are promoted out of the proxy into native tools.
 *
 * - omitted / `false`: proxy only. The model-facing surface stays exactly one
 *   tool, which is the only setting that keeps the request prefix constant.
 * - `true`: every (filtered) tool is registered natively.
 * - `string[]`: only the named tools are registered natively.
 * - `'search'`: tools are **staged, not registered**; `mcp({ search })` registers
 *   the ones it matches. This delays the prefix change until the model actually
 *   looks for a tool instead of paying it at startup.
 */
export type DirectToolsSetting = boolean | string[] | 'search'

/** One MCP server entry. */
export interface ServerEntry {
  /** Stable local namespace; unique across live rows. */
  serverName: string
  /** `stdio` spawns a child process; `streamable-http` connects to a URL. */
  transport: 'stdio' | 'streamable-http'

  // ── stdio ────────────────────────────────────────────────────────────────
  /** Executable to spawn. Required for `stdio`. */
  command?: string
  /** Arguments passed directly, without shell interpolation. */
  args?: string[]
  /** Extra env merged over the scrubbed ambient environment. */
  env?: Record<string, string>
  /**
   * Extra env whose values come from a command, keyed by variable name.
   *
   * Each command runs through `/bin/sh -c` once per spawn — the moment the
   * server is started, not the moment the host loaded its configuration — and
   * its trimmed stdout becomes the value. A command that fails, times out, or
   * prints nothing refuses to start the server rather than injecting a blank
   * value; list the name in {@link allowEmpty} to accept a blank one.
   *
   * Declared names are also substituted into `args` as `{{NAME}}`, which is the
   * only way to hand a secret to a server that takes it as an argument.
   */
  envFrom?: Record<string, string>
  /** Names in `envFrom` whose empty result is accepted instead of refused. */
  allowEmpty?: string[]
  /** Budget per `envFrom` command, in milliseconds. Defaults to 10 s. */
  envFromTimeoutMs?: number
  /** Working directory for the child process. */
  cwd?: string

  // ── streamable-http ──────────────────────────────────────────────────────
  /** MCP endpoint URL. Required for `streamable-http`. */
  url?: string
  /** Extra request headers. */
  headers?: Record<string, string>

  // ── shared ───────────────────────────────────────────────────────────────
  /** Per-`tools/call` timeout in milliseconds. */
  toolCallTimeoutMs?: number
  /** Lifecycle mode; see {@link ServerLifecycle}. */
  lifecycle?: ServerLifecycle
  /**
   * Minutes of idleness before the connection is reaped. Overrides the global
   * `idleTimeout`; `0` disables reaping for this server.
   */
  idleTimeout?: number
  /** Native-tool promotion; see {@link DirectToolsSetting}. */
  directTools?: DirectToolsSetting
  /** Keep only tools matching these names or globs. */
  includeTools?: string[]
  /** Drop tools matching these names or globs; applied after `includeTools`. */
  excludeTools?: string[]
  /**
   * Extra search keywords per tool, keyed by original name or glob. Keywords
   * only affect `mcp({ search })` ranking — they never reach a schema, a
   * description, or the cache.
   */
  searchKeywords?: Record<string, string[]>
  /** Keep the entry visible in status but refuse to connect or call. */
  disabled?: boolean
  /**
   * Forward the stdio child's stderr to the host instead of capturing it.
   *
   * Captured is the default because the tail is what explains a startup
   * failure; set this when you want the child's live log on your terminal and
   * are debugging by hand.
   */
  debug?: boolean
}

/** Resolved plugin configuration. */
export interface Config {
  /** Idle-reap window in minutes for servers without their own. `0` disables. */
  idleTimeout: number
  /**
   * Stop promoting `directTools` after the first sync.
   *
   * Promotion is the only thing that can move the model-facing tool surface.
   * Leaving this off means a server that keeps editing its catalog keeps
   * changing the request prefix; turning it on bounds that to one event.
   */
  freezeDirectTools?: boolean
  /**
   * Promotion default for every server, overridden per server.
   *
   * `true` registers every tool of every server natively; `'search'` registers
   * them inactive until a search matches. A server's own `directTools` wins,
   * including `false`, which is how one server opts out of a plugin-wide `true`.
   *
   * This mirrors `settings.directTools` in `pi-mcp-adapter`, so a configuration
   * carried over from there behaves the same way. The list form
   * (`directTools: string[]`) stays per-server, because a list of names has no
   * meaning across servers that do not share a catalog.
   */
  directTools?: boolean | 'search'
  /**
   * Bound server-authored output before it reaches the model.
   *
   * On by default: the gateway saves a few hundred tokens per request, and one
   * unbounded tool result can cost far more than that. Nothing upstream
   * truncates tool output, so this is the only place it can happen. `false`
   * turns it off; an object tunes the ceilings.
   */
  outputGuard?: boolean | OutputGuardConfig
  /** The server list. */
  servers: ServerEntry[]
  /**
   * Optional override for a server's idle window in milliseconds.
   *
   * Resolved configuration never sets this: {@link ServerEntry.idleTimeout} and
   * the plugin-level `idleTimeout` are the user-facing controls. It exists so a
   * host (or a test) can pin the window without going through minutes.
   */
  idleWindowMs?: (entry: ServerEntry) => number
  /**
   * How long a failed server is left alone before an automatic retry, in
   * milliseconds. Defaults to {@link FAILURE_BACKOFF_MS}.
   *
   * A supported setting: the plugin-level `failureBackoffMs` is the user-facing
   * spelling, and `0` retries immediately. An explicit `mcp({ connect })` always
   * ignores the window, so an operator who has just fixed a command does not
   * have to wait it out.
   */
  failureBackoffMs?: number
}

/** Bounding of one server-authored payload before it reaches the model. */
export interface OutputGuardConfig {
  /** `false` returns oversized output verbatim. Defaults to enabled. */
  enabled?: boolean
  /** Inline byte ceiling; the remainder is spilled to a temp file. */
  maxBytes?: number
  /** Inline line ceiling; the remainder is spilled to a temp file. */
  maxLines?: number
}

/** Raw config as it appears in `cordis.yml`/`cordis.patch.yml`. */
export type ConfigInput = Partial<Config>

/**
 * One projected block from an MCP tool result.
 *
 * Images and audio are reported as metadata rather than inlined: this plugin's
 * tool output is text, and saying what arrived and how large it was is more
 * useful to the model than silently dropping it.
 */
export type ProjectedBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; bytes: number }
  | { type: 'audio'; mimeType: string; bytes: number }
  | { type: 'resource_link'; uri: string; name?: string }
  | { type: 'unknown'; detail: string }

/** What one `tools/call` produced, after projection. */
export interface ToolCallResult {
  /** The server reported an error result (`isError: true`). */
  isError: boolean
  /** Projected content, in the order the server returned it. */
  blocks: ProjectedBlock[]
  /** Structured content, when the server published any. */
  structuredContent?: unknown
}

/** One tool as advertised by a server, after filtering and naming. */
export interface ToolMetadata {
  /** The server's own tool name — the only name ever sent on the wire. */
  originalName: string
  /** `serverName__originalName`, normalized to the function-name contract. */
  qualifiedName: string
  /** Description as advertised by the server. */
  description: string
  /** Advertised input schema, kept verbatim for `describe` and validation. */
  inputSchema?: unknown
  /** Advertised output schema, when the server publishes one. */
  outputSchema?: unknown
}

/** Per-server slice of the metadata cache. */
export interface ServerCacheEntry {
  /** Hash of the transport-relevant config; a change invalidates the entry. */
  configHash: string
  /** Epoch milliseconds when this entry was written. */
  cachedAt: number
  /** Tools discovered at that time. */
  tools: ToolMetadata[]
  /** The server's own usage instructions, when it published any. */
  instructions?: string
}

/** On-disk metadata cache. */
export interface MetadataCache {
  version: number
  servers: Record<string, ServerCacheEntry>
}

/** Live connection state for one server. */
export type ServerConnectionState = 'disconnected' | 'connecting' | 'connected' | 'failed'

/** What `mcp({})` reports about one server. */
export interface ServerStatus {
  serverName: string
  state: ServerConnectionState
  lifecycle: ServerLifecycle
  disabled: boolean
  /** Tool count known from cache or a live connection. */
  toolCount: number
  /** Whether the tool list came from cache rather than a live server. */
  fromCache: boolean
  /** Whether the connection is live right now. */
  connected: boolean
  /** Age of the cached metadata in seconds, when cached. */
  cachedAgeSeconds?: number
  /**
   * Seconds since this server last failed to start, while it is still being
   * left alone. Present exactly when a retry is currently suppressed.
   */
  failedAgoSeconds?: number
  /** Diagnostic for the most recent failure. */
  lastError?: string
}
