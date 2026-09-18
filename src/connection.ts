/**
 * Lazy MCP connections.
 *
 * Every server in this plugin is contacted through this module, and none of them
 * is contacted until something asks for a tool. A connection is created on first
 * use, kept while it is being used, and reaped once it has been idle past its
 * window — so a session that never touches a server never pays for its process.
 *
 * Three properties matter and are enforced here rather than hoped for:
 *
 * - **No startup I/O.** The constructor starts one timer and nothing else.
 * - **One process per server.** Concurrent first calls share a single in-flight
 *   connection promise instead of racing to spawn two children.
 * - **Never reap work in progress.** The idle check requires zero in-flight
 *   calls and a live connection, so a long call cannot be killed underneath
 *   itself.
 *
 * @module dsh-mcp-lazy/connection
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import { interpolateArgs, resolveEnvFrom } from './env-from.js'
import type { GatewayConnection, LiveToolCatalog } from './registry.js'
import { DEFAULT_TOOL_CALL_TIMEOUT_MS } from './schema.js'
import type { ProjectedBlock, ServerEntry, ToolCallResult, ToolMetadata } from './types.js'

/** How often idle connections are checked, in milliseconds. */
export const IDLE_SWEEP_INTERVAL_MS = 30_000

/** Reported when the package manifest cannot be read at all. */
const UNKNOWN_CLIENT_VERSION = '0.0.0-unknown'

/**
 * The package manifest, resolved at load time.
 *
 * This module is emitted into `lib/`, which sits directly under the package
 * root, so one `..` from the built file is the manifest. A source-level import
 * is not an option: `erasableSyntaxOnly` rules out an import assertion, and a
 * JSON import would need a loader Node does not enable for a published package.
 */
function readPackageVersion(): string {
  try {
    const manifest = fileURLToPath(new URL('../package.json', import.meta.url))
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
    const version = (parsed as { version?: unknown } | null)?.version
    return typeof version === 'string' && version !== '' ? version : UNKNOWN_CLIENT_VERSION
  } catch {
    // Reporting which client is calling is a diagnostic, not a capability. A
    // missing or unreadable manifest must not be what stops a server from
    // starting — so the fallback is a wrong version, never a broken connect.
    return UNKNOWN_CLIENT_VERSION
  }
}

/**
 * The version this plugin advertises to every MCP server it spawns.
 *
 * Read from `package.json` rather than written here. The literal it replaced
 * had already fallen two releases behind, and every server the gateway spoke
 * to was told the wrong version — a number nothing in the suite could notice,
 * because there was nothing to compare it against.
 */
export const CLIENT_VERSION = readPackageVersion()

/**
 * Permissive result schema.
 *
 * Deliberately not the MCP SDK's `CallToolResultSchema`: that schema validates
 * the *client's* view of a result, and a server whose advertised output schema
 * uses vocabulary the harness does not model would be rejected before this code
 * could see the payload. Reading a loosely-typed record and projecting the parts
 * this plugin understands keeps an exotic server usable instead of fatal.
 */
const LooseToolResultSchema = z.record(z.string(), z.unknown())

/** Most characters of a child's stderr kept for a failure diagnostic. */
export const MAX_STDERR_CHARS = 8 * 1024

/** How many of the child's last stderr lines get quoted in an error. */
export const MAX_STDERR_LINES = 3

/**
 * A bounded rolling tail of a child process's stderr.
 *
 * Bounded because a server may log without limit and what is wanted is a
 * diagnostic, not a transcript: the last few lines of a crash explain it, and
 * the first megabytes do not.
 */
export class StderrTail {
  #text = ''

  /**
   * Append a chunk, keeping only the most recent {@link MAX_STDERR_CHARS}.
   *
   * @param chunk - Bytes or text from the child's stderr.
   */
  push(chunk: Buffer | string): void {
    this.#text = `${this.#text}${String(chunk)}`.slice(-MAX_STDERR_CHARS)
  }

  /** The last few non-empty lines, joined for an error message. */
  get summary(): string {
    const lines = this.#text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '')
    return lines.slice(-MAX_STDERR_LINES).join(' — ')
  }
}

/**
 * Append a child's stderr tail to a connection error.
 *
 * The tail is often the only place a startup failure explains itself, so it is
 * folded into the message the model and the operator actually see.
 *
 * @param error - The original failure.
 * @param summary - The captured stderr tail; empty when there was none.
 * @returns The original error when there is nothing to add, else a new one.
 */
function withStderrTail(error: unknown, summary: string): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (summary === '') return error instanceof Error ? error : new Error(message)
  return new Error(`${message} (stderr: ${summary})`, { cause: error })
}

/** One live connection. */
interface ConnectionState {
  client: Client
  /** Epoch milliseconds of the last completed or started call. */
  lastUsedAt: number
  /** Calls currently in flight; a non-zero count blocks reaping. */
  inFlight: number
  /** Catalog as last fetched from this connection. */
  catalog: LiveToolCatalog
}

/** Options for the lazy connection layer. */
export interface LazyConnectionOptions {
  /** Current epoch milliseconds; injectable for tests. */
  now?: () => number
  /** Idle sweep interval in milliseconds. */
  sweepIntervalMs?: number
  /** Whether to schedule the idle sweep at all (tests may drive it manually). */
  startSweeper?: boolean
}

/**
 * Base64 length of one image payload, for diagnostics.
 *
 * @param data - Base64 payload as sent over the wire.
 * @returns An approximate decoded byte count.
 */
function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding)
}

/**
 * Read one property from an unknown record.
 *
 * @param value - Candidate record.
 * @param key - Property name.
 * @returns The property value, or `undefined`.
 */
function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return (value as Record<string, unknown>)[key]
}

/**
 * Project one raw MCP content block.
 *
 * Images and audio are reported as metadata rather than inlined: this plugin's
 * tool output is text, and silently dropping a payload would be worse than
 * saying what arrived and how big it was. Durable image forwarding is tracked in
 * `docs/design/plan.md` as a known v1 limitation.
 *
 * @param block - One raw content block from the server.
 * @returns The projected block.
 */
export function projectBlock(block: unknown): ProjectedBlock {
  const type = readProperty(block, 'type')
  switch (type) {
    case 'text': {
      const text = readProperty(block, 'text')
      return { type: 'text', text: typeof text === 'string' ? text : '' }
    }
    case 'image': {
      const mimeType = readProperty(block, 'mimeType')
      const data = readProperty(block, 'data')
      return {
        type: 'image',
        mimeType: typeof mimeType === 'string' ? mimeType : 'application/octet-stream',
        bytes: typeof data === 'string' ? base64Bytes(data) : 0,
      }
    }
    case 'audio': {
      const mimeType = readProperty(block, 'mimeType')
      const data = readProperty(block, 'data')
      return {
        type: 'audio',
        mimeType: typeof mimeType === 'string' ? mimeType : 'application/octet-stream',
        bytes: typeof data === 'string' ? base64Bytes(data) : 0,
      }
    }
    case 'resource_link': {
      const uri = readProperty(block, 'uri')
      const name = readProperty(block, 'name')
      const projected: ProjectedBlock = { type: 'resource_link', uri: typeof uri === 'string' ? uri : '' }
      if (typeof name === 'string') projected.name = name
      return projected
    }
    default:
      return { type: 'unknown', detail: `unsupported content block of type ${JSON.stringify(type)}` }
  }
}

/**
 * Project one raw MCP tool result.
 *
 * @param raw - The loosely-typed result record.
 * @returns The projected result.
 */
export function projectToolResult(raw: Record<string, unknown>): ToolCallResult {
  const content = raw['content']
  const blocks: ProjectedBlock[] = Array.isArray(content)
    ? content.map(block => projectBlock(block))
    : []
  const result: ToolCallResult = {
    isError: raw['isError'] === true,
    blocks,
  }
  if (raw['structuredContent'] !== undefined) result.structuredContent = raw['structuredContent']
  return result
}

/**
 * Normalize one advertised tool entry into {@link ToolMetadata}.
 *
 * A tool without a usable `name` is dropped rather than named `undefined`; the
 * server may also advertise a name the function-name contract cannot carry, in
 * which case the raw name is kept here and normalized later by the naming
 * module.
 *
 * @param raw - One entry from `tools/list`.
 * @param serverName - Owning server, for the qualified name.
 * @param qualify - Naming function, injected to keep this module dependency-free.
 * @returns The tool metadata, or `undefined` when the entry is unusable.
 */
export function normalizeTool(
  raw: unknown,
  serverName: string,
  qualify: (serverName: string, originalName: string) => string,
): ToolMetadata | undefined {
  const name = readProperty(raw, 'name')
  if (typeof name !== 'string' || name === '') return undefined
  const description = readProperty(raw, 'description')
  const inputSchema = readProperty(raw, 'inputSchema')
  const outputSchema = readProperty(raw, 'outputSchema')
  const tool: ToolMetadata = {
    originalName: name,
    qualifiedName: qualify(serverName, name),
    description: typeof description === 'string' ? description : '',
  }
  if (inputSchema !== undefined) tool.inputSchema = inputSchema
  if (outputSchema !== undefined) tool.outputSchema = outputSchema
  return tool
}

/**
 * The lazy connection layer.
 *
 * Implements the registry's {@link GatewayConnection} port: one live client per
 * server, created on demand and reaped when idle.
 */
export class LazyConnections implements GatewayConnection {
  readonly #states = new Map<string, ConnectionState>()
  readonly #errors = new Map<string, string>()
  /** In-flight connect attempts, so concurrent first calls share one process. */
  readonly #connecting = new Map<string, Promise<LiveToolCatalog>>()
  /** Called whenever a live server advertises a changed tool list. */
  #onCatalogChanged: ((serverName: string, catalog: LiveToolCatalog) => void) | undefined
  /** Resolved idle window per server, in milliseconds; `0` disables reaping. */
  readonly #idleWindows = new Map<string, number>()
  /** Entry object per server, so a window can be resolved from a name alone. */
  readonly #entries = new Map<string, ServerEntry>()
  readonly #now: () => number
  readonly #idleWindowMs: (entry: ServerEntry) => number
  /** Naming function used for fetched tools; replaced by the registry. */
  #qualify: (serverName: string, originalName: string) => string = (_server, original) => original
  #sweeper: NodeJS.Timeout | undefined
  #disposed = false

  /**
   * @param idleWindowMs - Resolves a server's idle window in milliseconds.
   * @param options - Sweep interval and clock injection.
   */
  constructor(
    idleWindowMs: (entry: ServerEntry) => number = () => 0,
    options: LazyConnectionOptions = {},
  ) {
    this.#now = options.now ?? (() => Date.now())
    this.#idleWindowMs = idleWindowMs
    if (options.startSweeper !== false) {
      this.#sweeper = setInterval(() => {
        void this.sweepIdle()
      }, options.sweepIntervalMs ?? IDLE_SWEEP_INTERVAL_MS)
      // Reaping is housekeeping; it must never hold the host process open.
      this.#sweeper.unref?.()
    }
  }

  /** Servers whose last operation failed, for status output. */
  get errors(): ReadonlyMap<string, string> {
    return this.#errors
  }

  /**
   * Record the last failure seen for one server.
   *
   * One place, so the reason a server is reported broken reads the same whether
   * it arrived through a connect attempt, a rejected refresh, or a listener that
   * threw.
   *
   * @param serverName - The server the failure belongs to.
   * @param error - The failure, in whatever form it arrived.
   */
  #recordError(serverName: string, error: unknown): void {
    this.#errors.set(serverName, error instanceof Error ? error.message : String(error))
  }

  /**
   * Resolve the idle window for one server, caching the answer.
   *
   * @param entry - The server entry.
   * @returns The window in milliseconds; `0` means "never reap".
   */
  #windowFor(entry: ServerEntry): number {
    const cached = this.#idleWindows.get(entry.serverName)
    if (cached !== undefined) return cached
    const window = Math.max(0, this.#idleWindowMs(entry))
    this.#idleWindows.set(entry.serverName, window)
    this.#entries.set(entry.serverName, entry)
    return window
  }

  /**
   * Create and connect one client.
   *
   * @param entry - The server entry to connect.
   * @returns The live client.
   */
  async #open(entry: ServerEntry): Promise<Client> {
    const client = new Client(
      { name: 'dsh-mcp-lazy', version: CLIENT_VERSION },
      { capabilities: {} },
    )
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      const state = this.#states.get(entry.serverName)
      // A notification from a generation that has already been replaced is
      // stale by definition, and acting on it would publish an old catalog.
      if (state === undefined || state.client !== client) return
      try {
        const catalog = await this.#fetchCatalog(client, entry.serverName, this.#qualify)
        if (state.client !== client) return
        state.catalog = catalog
        state.lastUsedAt = this.#now()
      } catch (error) {
        // A failed refresh keeps the previous catalog: a stale list is better
        // than an empty one, and the next call will retry the fetch anyway.
        //
        // Recorded rather than dropped because this is the only place the
        // failure can be seen at all. A notification handler has no caller to
        // throw to, and an unhandled rejection here would take the process down.
        this.#recordError(entry.serverName, error)
        return
      }
      // Deliberately outside the guard above. The refresh failing and the
      // listener failing are different events: the first is expected and
      // silent, the second means native promotion did not happen — and folding
      // them together made the second indistinguishable from the first.
      try {
        this.#onCatalogChanged?.(entry.serverName, state.catalog)
      } catch (error) {
        this.#recordError(entry.serverName, error)
      }
    })
    const { transport, stderr } = await this.#createTransport(entry)
    try {
      await client.connect(transport)
    } catch (error) {
      throw withStderrTail(error, stderr.summary)
    }
    return client
  }

  /**
   * Build the transport for one entry, plus a stderr tail for diagnostics.
   *
   * The stdio child starts from the subprocess seam's scrubbed parent
   * environment — ambient credential-shaped names and stale `DSH_*` names are
   * dropped — with the entry's explicit `env` merged on top, so an override
   * survives and nothing else leaks through.
   *
   * @param entry - The server entry.
   * @returns The transport plus the child's captured stderr tail.
   */
  async #createTransport(
    entry: ServerEntry,
  ): Promise<{ transport: Transport; stderr: StderrTail }> {
    const stderr = new StderrTail()
    if (entry.transport === 'stdio') {
      const debug = entry.debug === true
      // Resolved here, into this scope, and nowhere else. The value exists for
      // the length of one spawn: it is never written back to the entry, never
      // cached, and never put in a message — which is what keeps it out of
      // `cache.json` and out of anything the model can read.
      //
      // Deliberately not given the caller's abort signal. A single `connect()`
      // attempt is shared by every caller waiting on it, so letting one
      // caller's cancellation kill the lookup would fail the others and open a
      // retry-backoff window over a decision that caller made on purpose.
      const resolvedFrom = await resolveEnvFrom(entry)
      const params: {
        command: string
        args: string[]
        env: Record<string, string>
        cwd?: string
        stderr: 'pipe' | 'inherit'
      } = {
        command: entry.command ?? '',
        args: interpolateArgs(entry.args ?? [], resolvedFrom),
        // Resolved values merge last: they are the ones the configuration asked
        // for at spawn time, and a name cannot appear in two of the three maps
        // (`assertEnvFrom` refuses the overlap at load).
        env: { ...scrubbedParentEnv(), ...(entry.env ?? {}), ...resolvedFrom },
        // The SDK defaults to `inherit`, which hands the stream to the host and
        // leaves `transport.stderr` null — no diagnostic is possible. Piping it
        // is what makes a startup failure explainable; `debug` buys the old
        // behaviour back for someone who wants the live log.
        stderr: debug ? 'inherit' : 'pipe',
      }
      if (entry.cwd !== undefined && entry.cwd !== '') params.cwd = entry.cwd
      const transport = new StdioClientTransport(params)
      // A server that dies during startup usually says why on stderr, and the
      // SDK's own error carries none of it. Keeping a bounded tail turns a bare
      // "connection closed" into the actual reason.
      if (!debug) transport.stderr?.on('data', (chunk: Buffer | string) => stderr.push(chunk))
      return { transport, stderr }
    }
    const options =
      entry.headers === undefined || Object.keys(entry.headers).length === 0
        ? undefined
        : { requestInit: { headers: entry.headers } }
    return {
      transport: new StreamableHTTPClientTransport(new URL(entry.url ?? ''), options),
      stderr,
    }
  }

  /**
   * Fetch one server's catalog over a live connection.
   *
   * Uses `client.request` with no result schema rather than the SDK's
   * `listTools()`: the raw JSON is normalized here, so a server advertising a
   * schema shape the SDK's validator dislikes cannot make its whole catalog
   * unusable.
   *
   * @param client - The live client.
   * @param serverName - Owning server, for qualified names.
   * @param qualify - Naming function.
   * @returns The normalized catalog.
   */
  async #fetchCatalog(
    client: Client,
    serverName: string,
    qualify: (serverName: string, originalName: string) => string,
  ): Promise<LiveToolCatalog> {
    const tools: ToolMetadata[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < 100; page += 1) {
      const raw: unknown = await client.request(
        { method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) },
        z.unknown(),
      )
      const list = readProperty(raw, 'tools')
      if (!Array.isArray(list)) break
      for (const item of list) {
        const tool = normalizeTool(item, serverName, qualify)
        if (tool === undefined || seen.has(tool.originalName)) continue
        seen.add(tool.originalName)
        tools.push(tool)
      }
      const next = readProperty(raw, 'nextCursor')
      if (typeof next !== 'string' || next === '') break
      if (next === cursor) break
      cursor = next
    }
    return { tools }
  }

  /**
   * Ensure a server is connected and return its catalog.
   *
   * Concurrent callers share one attempt: the in-flight promise is stored before
   * any awaiting happens, so a second call cannot start a second process.
   *
   * @param entry - The server entry.
   * @param signal - Caller cancellation.
   * @returns The live catalog.
   */
  async connect(entry: ServerEntry, signal?: AbortSignal): Promise<LiveToolCatalog> {
    if (this.#disposed) throw new Error('the gateway has been disposed')
    // Remember the entry before anything can be reaped, so the sweep can always
    // resolve this server's window from its name.
    this.#entries.set(entry.serverName, entry)
    this.#windowFor(entry)
    const existing = this.#states.get(entry.serverName)
    if (existing !== undefined) {
      existing.lastUsedAt = this.#now()
      return existing.catalog
    }
    const inFlight = this.#connecting.get(entry.serverName)
    if (inFlight !== undefined) return inFlight

    const attempt = (async (): Promise<LiveToolCatalog> => {
      let client: Client | undefined
      let handedOff = false
      try {
        client = await this.#open(entry)
        const catalog = await this.#fetchCatalog(client, entry.serverName, this.#qualify)
        if (this.#disposed) {
          throw new Error('the gateway was disposed while connecting')
        }
        this.#states.set(entry.serverName, {
          client,
          lastUsedAt: this.#now(),
          inFlight: 0,
          catalog,
        })
        handedOff = true
        this.#errors.delete(entry.serverName)
        // A server that dies on its own must not leave a dead entry behind.
        client.onclose = () => {
          const current = this.#states.get(entry.serverName)
          if (current?.client === client) this.#states.delete(entry.serverName)
        }
        return catalog
      } catch (error) {
        // Close anything that was opened but never handed to #states. A client
        // the state map does not know about is unreachable by sweepIdle,
        // disconnect, and dispose, so its child process would outlive every
        // mechanism that exists to end it — and the next attempt would spawn
        // another one. `tools/list` failing after a successful handshake is the
        // ordinary way to land here, and the SDK does not clean it up: as far as
        // it is concerned the connection succeeded.
        if (client !== undefined && !handedOff) await client.close().catch(() => undefined)
        this.#recordError(entry.serverName, error)
        throw error
      } finally {
        this.#connecting.delete(entry.serverName)
      }
    })()

    this.#connecting.set(entry.serverName, attempt)
    if (signal !== undefined) {
      // The attempt is shared, so caller cancellation must not cancel it for
      // everyone else; it only stops this caller from waiting.
      //
      // There is deliberately no shortcut for a signal that is already aborted.
      // Throwing before the cleanup below was attached left attempts that were
      // already running unobserved, and their rejection surfaced as an unhandled
      // rejection. The listener costs nothing here either way: the executor runs
      // synchronously, so it is registered and removed again within one tick.
      let onAbort: () => void = () => undefined
      const cancellation = new Promise<never>((_resolve, reject) => {
        onAbort = (): void => {
          reject(new Error('the tool call was canceled before the server connected'))
        }
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      })
      // `{ once: true }` only removes a listener when it actually fires, and the
      // ordinary outcome is the attempt settling first — which left one closure
      // and one unsettled promise pinned to the signal per attempt, forever.
      // Node does not warn either: `AbortSignal` is an `EventTarget`, and the
      // MaxListeners ceiling is only enforced for `EventEmitter`.
      const cleanup = attempt.then(
        catalog => {
          signal.removeEventListener('abort', onAbort)
          return catalog
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort)
          throw error
        },
      )
      // `cleanup`, not `attempt`. It settles identically and rejects with the
      // same object, but its rejection is observed by the handler above — so an
      // attempt nobody is waiting on any more cannot become an unhandled
      // rejection.
      return await Promise.race([cleanup, cancellation])
    }
    return await attempt
  }

  /**
   * Install the naming function used for fetched tools.
   *
   * @param qualify - The naming function.
   */
  setQualifier(qualify: (serverName: string, originalName: string) => string): void {
    this.#qualify = qualify
  }

  /**
   * Observe live tool-list changes.
   *
   * A server that adds or removes tools mid-session must not leave the gateway
   * routing to a stale catalog. Re-fetching is driven by the server's own
   * `notifications/tools/list_changed`, so the cache stays truthful without
   * polling anything.
   *
   * @param listener - Called with the refreshed catalog.
   */
  onCatalogChanged(listener: (serverName: string, catalog: LiveToolCatalog) => void): void {
    this.#onCatalogChanged = listener
  }

  /**
   * Call one tool on a connected server.
   *
   * @param entry - The server entry.
   * @param tool - The tool being called.
   * @param args - Arguments exactly as the caller supplied them.
   * @param signal - Caller cancellation.
   * @returns The projected result.
   */
  async invokeTool(
    entry: ServerEntry,
    tool: ToolMetadata,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolCallResult> {
    const state = this.#states.get(entry.serverName)
    if (state === undefined) {
      throw new Error(`server "${entry.serverName}" is not connected`)
    }

    state.inFlight += 1
    state.lastUsedAt = this.#now()
    try {
      const timeout = entry.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS
      const raw: unknown = await state.client.request(
        { method: 'tools/call', params: { name: tool.originalName, arguments: args } },
        LooseToolResultSchema,
        {
          ...(signal === undefined ? {} : { signal }),
          ...(timeout > 0 ? { timeout } : {}),
        },
      )
      return projectToolResult((raw ?? {}) as Record<string, unknown>)
    } finally {
      state.inFlight -= 1
      state.lastUsedAt = this.#now()
    }
  }

  /**
   * Close one server's connection.
   *
   * @param serverName - The server to disconnect.
   */
  async disconnect(serverName: string): Promise<void> {
    const state = this.#states.get(serverName)
    if (state === undefined) return
    this.#states.delete(serverName)
    await state.client.close().catch(() => undefined)
  }

  /**
   * Whether a server currently holds a live connection.
   *
   * @param serverName - The server name.
   * @returns Whether a client exists for it.
   */
  isConnected(serverName: string): boolean {
    return this.#states.has(serverName)
  }

  /**
   * Reap every connection that has been idle past its window.
   *
   * Exposed separately from the timer so tests can drive it deterministically
   * instead of waiting on wall-clock time.
   *
   * @returns The names of the servers that were reaped.
   */
  async sweepIdle(): Promise<string[]> {
    if (this.#disposed) return []
    const reaped: string[] = []
    const now = this.#now()
    for (const [serverName, state] of [...this.#states]) {
      const entry = this.#entries.get(serverName)
      if (entry === undefined) continue
      const window = this.#windowFor(entry)
      if (window <= 0) continue
      // Never reap a call in progress: the window is about idleness, not age.
      if (state.inFlight > 0) continue
      if (now - state.lastUsedAt <= window) continue
      reaped.push(serverName)
      await this.disconnect(serverName)
    }
    return reaped
  }

  /** Close every connection and stop the sweep timer. */
  async dispose(): Promise<void> {
    this.#disposed = true
    if (this.#sweeper !== undefined) {
      clearInterval(this.#sweeper)
      this.#sweeper = undefined
    }
    const names = [...this.#states.keys()]
    await Promise.all(names.map(name => this.disconnect(name)))
    this.#connecting.clear()
  }
}
