/**
 * The one model-facing tool.
 *
 * A single gateway tool is registered under a constant name with a constant
 * parameter schema, no matter how many servers are configured. That is the
 * entire token story: the model pays for one small tool instead of every MCP
 * tool's description and input schema, on every request, forever.
 *
 * The tool performs no caching itself — it validates its arguments, delegates to
 * the registry, and projects the result into text the model can act on.
 *
 * @module dsh-mcp-lazy/proxy-tool
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { OutputGuard } from './output-guard.js'
import { renderToolResult } from './projection.js'
import { McpGatewayRegistry, summarizeParameters } from './registry.js'
import { PROXY_TOOL_NAME, PROXY_TOOL_PARAMETERS } from './schema.js'
import { SERVER_NAME_PATTERN, type ServerStatus } from './types.js'

/** Arguments accepted by the proxy tool, as written by the model. */
interface ProxyArgs {
  search?: string
  describe?: string
  tool?: string
  args?: Record<string, unknown>
  server?: string
  connect?: string
  instructions?: string
  regex?: boolean
  includeSchemas?: boolean
  limit?: number
  offset?: number
}

/**
 * The tool description.
 *
 * Written to teach the whole workflow in a few hundred tokens: that this one
 * tool fronts every MCP server, that discovery is local and free, and that the
 * tool name must come from a search. Servers are named in configuration order
 * only, never with their tool counts, so the description is byte-stable.
 */
const PROXY_TOOL_DESCRIPTION =
  'Gateway to every configured MCP server. Discover tools with { search }, inspect one with { describe }, ' +
  'call one with { tool, args }. Search and describe are answered from a local metadata cache and start ' +
  'nothing; a server starts only when one of its tools is actually called, then stops once idle.'


/**
 * Render a failure to start a server.
 *
 * A server that cannot start is an ordinary, expected condition — a wrong
 * command, a disabled entry, a machine without the dependency — so it comes back
 * as text the model can act on rather than as a thrown tool failure that ends
 * the attempt with no explanation.
 *
 * @param serverName - The server that failed to start.
 * @param error - The failure.
 * @returns Text for the model.
 */
function renderConnectFailure(serverName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `Could not connect server "${serverName}": ${message}`
}

/**
 * The co-mounted `dsh-mcp-client` servers, as a fixed list or a live getter.
 *
 * A getter is the one that matters. Reading the declared entry tree once at
 * `apply` time goes stale whenever a change lands in a *different* layer: the
 * loader re-composes the tree and re-runs the entries whose own config changed,
 * and this plugin's config is not one of them. A server moved out of
 * `dsh-mcp-client` would then still be reported as co-mounted — wrong in the
 * direction that hides the saving this plugin exists to provide.
 *
 * The plain-array form stays in the union because it is the published signature
 * of `createProxyTool`; existing callers pass a snapshot and keep working.
 */
export type NativeServersSource = readonly string[] | (() => readonly string[])

/**
 * Resolve a {@link NativeServersSource} to a list, tolerating a throwing getter.
 *
 * The conflict notice is diagnostic. A getter that fails — a loader mid-reload,
 * a host without one — must degrade to "nothing to report" rather than fail the
 * tool call that happened to ask for status.
 *
 * The container is checked as well as the getter's result: a JavaScript caller
 * that passes a bare string reaches the same dedupe pass, and `[...new Set('abc')]`
 * is three servers named `a`, `b` and `c` — names invented rather than reported.
 *
 * @param source - A fixed list, or a function returning the current list.
 * @returns The resolved list, or an empty list.
 */
function resolveNativeServers(source: NativeServersSource | undefined): readonly string[] {
  if (source === undefined) return []
  if (typeof source !== 'function') return Array.isArray(source) ? source : []
  try {
    const current = source()
    return Array.isArray(current) ? current : []
  } catch {
    return []
  }
}

/**
 * What the other plugin does with the servers it serves, in contrast to this one.
 *
 * Stated as that plugin's *mode* rather than as an effect on the current request,
 * because this gateway cannot see the effect. Two adversarial reviews found the
 * difference matters: a native row whose `config` mcp-client rejects — it requires
 * `transport` plus `command` or `url`, not just `serverName` — registers nothing,
 * and a row whose server is down registers nothing either, since mcp-client drops
 * a server whose reconnect budget is spent. A clause claiming "those schemas enter
 * every request" was false in both states.
 */
const NATIVE_MODE =
  'which registers MCP tools natively instead of leaving them behind this gateway\'s search'

/**
 * What one warning needs beyond the names and their state.
 */
interface WarningParts {
  /**
   * `different-case` only: the local spelling each native name nearly matched, in
   * order, narrowed to one entry per folded name — each carrying its own
   * `disabled` flag, because that flag belongs to the row rather than to the
   * sentence.
   */
  readonly near?: readonly { readonly name: string; readonly disabled: boolean }[]
  /**
   * The subset of `names` this gateway would register natively itself, because
   * `directTools` opts them into promotion.
   */
  readonly promoting?: readonly string[]
}

/**
 * The four states a natively-enabled server can be in here, and the advice each
 * one actually needs.
 *
 * `both`: this gateway has it enabled too, so one of the two copies has to go.
 * `listed-disabled`: the entry is already here and switched off — the advice must
 * be to clear that flag, because *adding* it would create a second entry with the
 * same `serverName` and the registry constructor throws `mcp-lazy: duplicate
 * serverName` on those, so following a "move it here" would stop the plugin from
 * loading. `different-case`: a configured name differs only by case, so it is a
 * different entry rather than this one, and "add it here" would leave two servers
 * serving the same thing. `absent`: there is nothing here at all.
 */
type NativeState = 'both' | 'listed-disabled' | 'different-case' | 'absent'

/**
 * The note that keeps the advice honest when this gateway promotes the server too.
 *
 * `directTools` is the one setting that makes this gateway register tools natively
 * itself, so bringing a server here — or keeping it here — does not stop those
 * schemas while it is set. Dropping the server entirely still does, and that
 * option is already in every one of these sentences.
 *
 * @param promoting - The subset of the sentence's names that would be promoted.
 * @param total - How many names the sentence carries, to choose the subject.
 * @returns One sentence, with a leading space, or an empty string.
 */
function promoteCaveat(promoting: readonly string[], total: number): string {
  if (promoting.length === 0) return ''
  const subject =
    promoting.length === total
      ? total === 1
        ? 'it'
        : 'them'
      : promoting.map(name => `\`${name}\``).join(' and ')
  return (
    ` Keeping ${subject} here does not stop those schemas while \`directTools\` is set, ` +
    'because this gateway registers such tools natively itself.'
  )
}

/**
 * One warning about a server the native MCP plugin is enabled for.
 *
 * Configuration is all it speaks about. The listing it is appended to prints
 * `failed` and the spawn error for a server whose start failed, so a claim that
 * "both run" contradicted its own output; and the reason is {@link NATIVE_MODE},
 * that plugin's mode, rather than a claim about what enters a request.
 *
 * Every piece of advice here has to be *executable*, and *sufficient*. Two earlier
 * wordings failed the first test: "move it here" against an entry this gateway
 * already lists, because a second entry with the same `serverName` throws in the
 * registry constructor, and "spell them the same" against several native
 * spellings, because mcp-client raises `serverName "X" is already in use by
 * another mcp-client instance` for the second row and rejects it. The second test
 * is what {@link promoteCaveat} answers: advice to keep a server here is not enough
 * while `directTools` registers it natively anyway.
 *
 * @param names - The servers this sentence names. Never empty.
 * @param state - Which of the four states above these servers are in.
 * @param parts - The state's detail and the promoting subset. Empty for the rest.
 * @returns One line for the status listing.
 */
function renderNativeWarning(
  names: readonly string[],
  state: NativeState,
  parts: WarningParts = {},
): string {
  const single = names.length === 1
  const plural = single ? '' : 's'
  const verb = single ? 'is' : 'are'
  const them = single ? 'it' : 'them'
  const subject = `${names.length} server${plural} (${names.join(', ')})`
  let body: string
  if (state === 'both') {
    body =
      `⚠ ${subject} ${verb} configured both here and in @deepseek-ai/dsh-mcp-client, ` +
      `${NATIVE_MODE}. Remove ${them} from one of the two.`
  } else if (state === 'listed-disabled') {
    body =
      `⚠ ${subject} ${verb} enabled in @deepseek-ai/dsh-mcp-client, ${NATIVE_MODE}. ` +
      `This gateway lists ${them} with \`disabled: true\`; clear that flag — adding ` +
      `${them} again would be a duplicate — or disable the native row if you do not need it.`
  } else if (state === 'different-case') {
    // De-duplicated by spelling, and marked *per spelling*: `disabled` belongs to
    // the row, not to the sentence. A sentence-wide flag dropped the marker from a
    // switched-off row that sat beside a live one, and a trailing suffix after two
    // names read as applying to the last of them — both measured on a local
    // `Mine`(disabled) beside `Yours`(enabled) against native `mine` and `yours`.
    const named = new Map<string, boolean>()
    for (const match of parts.near ?? []) {
      if (!named.has(match.name)) named.set(match.name, match.disabled)
    }
    const near = [...named]
      .map(([name, disabled]) => `\`${name}\`${disabled ? ' (switched off)' : ''}`)
      .join(' and ')
    body =
      `⚠ ${subject} ${verb} enabled in @deepseek-ai/dsh-mcp-client, ${NATIVE_MODE}. ` +
      `This gateway's list uses ${near}, differing only by case, so the names are ` +
      `separate namespaces rather than one entry. If these are all the same server, keep ` +
      `one row and delete the rest; if not, spell the difference out.`
  } else {
    body =
      `⚠ ${subject} ${verb} enabled in @deepseek-ai/dsh-mcp-client, ${NATIVE_MODE}. ` +
      `This gateway does not have ${them}; add ${them} here, or disable the native row if ` +
      'you do not need it.'
  }
  return body + promoteCaveat(parts.promoting ?? [], names.length)
}

/**
 * One warning about natively-enabled entries whose `serverName` this gateway cannot use.
 *
 * `detectNativelyRegistered` substitutes `UNNAMED_NATIVE_NAME` (`src/types.ts`) when
 * an entry's `serverName` is not a plain string, and the pattern filter would
 * otherwise drop it in silence. Silence is the wrong default: a `!!js` expression
 * stays a raw node in the loader's options — the loader evaluates it only for the
 * config it hands the plugin — so that row registers tools under its evaluated
 * name while this gateway has nothing to match against.
 *
 * The wording claims *matchability*, not absence, because the two cannot be told
 * apart here: a config that spells the placeholder literally (or a caller passing
 * it through the exported array seam) puts the same string in the same list as a
 * genuine substitution does. "No `serverName` this gateway can match" is true of
 * both, while "has no `serverName`" would be false of the literal one.
 *
 * The count covers exactly the strings that failed the pattern, which is the same
 * set the sentence enumerates: a substituted placeholder, a literal one, and names
 * that are merely invalid — blank, or past the length limit — are all counted, so
 * the number and the claim cannot drift apart. Elements that are not strings are
 * not counted: `detectNativelyRegistered` never emits one, and a caller passing
 * junk gets no invented rows.
 *
 * @param count - How many such entries the native list reported. Never zero.
 * @returns One line for the status listing.
 */
function renderUnmatchedNotice(count: number): string {
  const single = count === 1
  return (
    `⚠ ${count} entr${single ? 'y' : 'ies'} in @deepseek-ai/dsh-mcp-client ` +
    `${single ? 'has' : 'have'} no serverName this gateway can match — a \`!!js\` expression, ` +
    `a missing or empty field, or a name outside ${SERVER_NAME_PATTERN}. ` +
    `${single ? 'It is' : 'They are'} not compared against this gateway's list, so check ` +
    `${single ? 'it' : 'them'} by hand.`
  )
}

/**
 * Render the status listing.
 *
 * @param servers - Per-server status snapshots.
 * @param cachePath - Where the metadata cache lives.
 * @param nativeServers - A fixed list, or a getter read at render time.
 * @param promotes - Whether this gateway would register a server natively itself,
 *   which `directTools` decides. Defaults to "none", so a caller that does not know
 *   gets no caveat rather than a guess.
 * @returns Text for the model.
 */
function renderStatus(
  servers: readonly ServerStatus[],
  cachePath: string,
  nativeServers: NativeServersSource = [],
  promotes: (serverName: string) => boolean = () => false,
): string {
  const reported = resolveNativeServers(nativeServers)
  // One name is one server: a duplicated loader entry is the same server, and the
  // second instance fails mcp-client's own "already in use" check.
  const unique = [...new Set(reported)]
  // mcp-client's own Config requires a `serverName` matching this pattern
  // (`z.string().required().pattern(SERVER_NAME_PATTERN)`, the same regex). Empty or
  // over-long names cannot address a server either, and neither can elements of the
  // exported array seam, which need not even be strings: `RegExp.test` coerces, and
  // `join` rendered `undefined` as nothing, so `()` reached a sentence. The
  // `(unnamed)` placeholder is dropped here and reported on separately below.
  const native = unique.filter(
    name => typeof name === 'string' && SERVER_NAME_PATTERN.test(name),
  )
  // Every string the filter above dropped, not just the placeholder: a name that
  // is merely invalid is just as unmatchable, and counting only one of the two
  // would make the number disagree with the sentence that prints it. Counted on
  // the raw list, not on `unique`: two unmatchable rows are two rows to look at,
  // while two entries sharing a real name are one server.
  const unmatchedCount = reported.filter(
    name => typeof name === 'string' && !SERVER_NAME_PATTERN.test(name),
  ).length
  // Membership of this gateway's config is not the same question as whether it
  // serves the server: `status` lists disabled entries too, and a disabled entry
  // needs "switch it on here", not "add it here".
  const enabledHere = new Set(
    servers.filter(server => !server.disabled).map(server => server.serverName),
  )
  const listedHere = new Set(servers.map(server => server.serverName))
  // A native name differing from a configured one only by case is not that entry:
  // both plugins key servers by exact name, so the two are separate namespaces.
  // Enabled spellings win, because the sentence has to name the row the reader can
  // act on — a switched-off case-variant is not it when a live one exists, and the
  // listing prints both. Within a pass, insertion order decides.
  const localByLower = new Map<string, { name: string; disabled: boolean }>()
  const remember = (server: ServerStatus): void => {
    const lower = server.serverName.toLowerCase()
    if (!localByLower.has(lower)) {
      localByLower.set(lower, { name: server.serverName, disabled: server.disabled })
    }
  }
  for (const server of servers) {
    if (!server.disabled) remember(server)
  }
  for (const server of servers) {
    if (server.disabled) remember(server)
  }
  const both: string[] = []
  const listedDisabled: string[] = []
  const differentCase: string[] = []
  const caseNear: { name: string; disabled: boolean }[] = []
  const casePromoting: string[] = []
  const absent: string[] = []
  for (const name of native) {
    if (enabledHere.has(name)) both.push(name)
    else if (listedHere.has(name)) listedDisabled.push(name)
    else {
      const near = localByLower.get(name.toLowerCase())
      if (near === undefined) absent.push(name)
      else {
        differentCase.push(name)
        caseNear.push(near)
        // Asked about the *local* spelling, not the native name: the row the advice
        // tells the reader to keep is the local one, and its setting is what decides
        // whether keeping it leaves the schemas in place.
        if (promotes(near.name)) casePromoting.push(name)
      }
    }
  }
  const caseParts: WarningParts = { near: caseNear }
  // Which of a group this gateway would promote itself. Asked per sentence rather
  // than once, because `directTools` is a per-server setting and a group can mix
  // servers that opted in with servers that did not.
  const promoting = (group: readonly string[]): string[] => group.filter(promotes)
  // Named unconditionally: these are the only lines here that describe a problem
  // with the *configuration* rather than with a server, and they silently cancel
  // the reason the plugin was installed.
  const conflict = [
    ...(both.length === 0
      ? []
      : ['', renderNativeWarning(both, 'both', { promoting: promoting(both) })]),
    ...(listedDisabled.length === 0
      ? []
      : [
          '',
          renderNativeWarning(listedDisabled, 'listed-disabled', {
            promoting: promoting(listedDisabled),
          }),
        ]),
    ...(differentCase.length === 0
      ? []
      : [
          '',
          renderNativeWarning(differentCase, 'different-case', {
            ...caseParts,
            promoting: casePromoting,
          }),
        ]),
    ...(absent.length === 0
      ? []
      : ['', renderNativeWarning(absent, 'absent', { promoting: promoting(absent) })]),
    ...(unmatchedCount === 0 ? [] : ['', renderUnmatchedNotice(unmatchedCount)]),
  ]

  if (servers.length === 0) {
    return [
      'No MCP servers are configured. Add entries under this plugin\'s `servers` config, then start a new session.',
      ...conflict,
    ].join('\n')
  }

  // A server with no catalog and no cache is the one state the model cannot
  // work around on its own: search has nothing to match, so it cannot discover
  // a tool name to call, and calling is what would have fetched the catalog.
  // Naming those servers is the whole point of this listing.
  const uncached = servers.filter(
    server => !server.disabled && !server.connected && !server.fromCache && server.toolCount === 0,
  )

  const lines = servers.map(server => {
    const flags: string[] = [server.lifecycle]
    if (server.disabled) flags.push('disabled')
    if (server.connected) flags.push('connected')
    else if (server.state === 'failed') flags.push('failed')
    if (server.failedAgoSeconds !== undefined) {
      flags.push(`retry suppressed, failed ${server.failedAgoSeconds}s ago`)
    }
    if (server.fromCache) flags.push('metadata from cache')
    if (!server.connected && !server.fromCache && server.toolCount === 0 && !server.disabled) {
      flags.push('no metadata yet')
    }
    const age = server.cachedAgeSeconds === undefined ? '' : `, cached ${server.cachedAgeSeconds}s ago`
    const error = server.lastError === undefined ? '' : `\n      last error: ${server.lastError}`
    return (
      `  ${server.serverName} — ${server.toolCount} tool${server.toolCount === 1 ? '' : 's'} ` +
      `(${flags.join(', ')}${age})${error}`
    )
  })

  const hint =
    uncached.length === 0
      ? 'Servers not marked connected are idle; calling one of their tools starts it.'
      : `Search cannot find tools on ${uncached.map(server => server.serverName).join(', ')} yet, ` +
        'because nothing is cached and no server has been started. Call ' +
        `${uncached.map(server => `mcp({ connect: "${server.serverName}" })`).join(' or ')} once; ` +
        'after that their tools are searchable without starting anything.'

  return [
    `${servers.length} MCP server${servers.length === 1 ? '' : 's'} configured.`,
    ...lines,
    '',
    `Metadata cache: ${cachePath}`,
    hint,
    ...conflict,
  ].join('\n')
}

/**
 * Render a search result set.
 *
 * @param outcome - The registry's search outcome.
 * @returns Text for the model.
 */
function renderSearch(outcome: ReturnType<McpGatewayRegistry['search']>): string {
  // A rejected pattern is not an empty result set. Reporting it as "no matches"
  // would teach the model that the tool does not exist, so the reason is passed
  // through verbatim and the model can fix the pattern.
  if (outcome.error !== undefined) return `Could not run that search: ${outcome.error}`

  if (outcome.matches.length === 0) {
    if (outcome.coldCache) {
      return (
        `No tool metadata is cached yet, so there is nothing to search. Call ` +
        `mcp({ connect: "<server>" }) for a server you know you need, then search again.`
      )
    }
    return `No MCP tool matches "${outcome.query}". Try a broader term, or list every server with mcp({}).`
  }

  const lines = outcome.matches.map(match => {
    const header = `${match.tool}  [${match.server}]`
    const parameterLine = match.parameters === undefined ? '' : `\n      parameters: ${match.parameters}`
    const description = match.description === '' ? '' : `\n      ${match.description}`
    return `${header}${description}${parameterLine}`
  })

  const shown = `Showing ${outcome.matches.length} of ${outcome.total} matches`
  const paging = outcome.hasMore
    ? ` — more available with mcp({ search: ${JSON.stringify(outcome.query)}, offset: ${outcome.nextOffset} })`
    : ''
  const cached =
    outcome.cachedServers.length === 0
      ? ''
      : `\nMetadata for ${outcome.cachedServers.join(', ')} came from the cache; connect to refresh it.`

  return `${shown}${paging}\n\n${lines.join('\n')}${cached}\n\nCall one with mcp({ tool: "<name>", args: { ... } }).`
}

/**
 * Render one described tool.
 *
 * @param serverName - Owning server.
 * @param tool - Tool metadata, including its full input schema.
 * @returns Text for the model.
 */
function renderDescribe(serverName: string, tool: { qualifiedName: string; originalName: string; description: string; inputSchema?: unknown }): string {
  const summary = summarizeParameters(tool.inputSchema)
  const schema = tool.inputSchema === undefined ? '(the server advertised no input schema)' : JSON.stringify(tool.inputSchema)
  return [
    `${tool.qualifiedName}  [${serverName}]`,
    tool.description === '' ? '(no description)' : tool.description,
    '',
    summary === undefined ? 'Parameters: (none declared)' : `Parameters: ${summary}`,
    '',
    'Input schema:',
    schema,
    '',
    `Call it with mcp({ tool: ${JSON.stringify(tool.originalName)}, server: ${JSON.stringify(serverName)}, args: { ... } }).`,
  ].join('\n')
}

/**
 * Bound one server-authored payload before it reaches the model.
 *
 * Only payloads the *server* wrote are guarded: a tool result, a tool's schema,
 * a server's instructions. The gateway's own status, search and error text is
 * generated here and is bounded by construction, so running it through the
 * guard would only add a spill file that nobody needs.
 *
 * @param text - The rendered payload.
 * @param guard - The guard, when one is configured.
 * @returns The payload, truncated and spilled if it exceeded the ceilings.
 */
async function guardServerText(text: string, guard: OutputGuard | undefined): Promise<string> {
  if (guard === undefined) return text
  return (await guard.guard(text)).text
}

/**
 * `{ search }`: answer from the local cache, then let promotion react to it.
 *
 * The search itself starts nothing — it ranks the documents already known — so
 * the answer is free. The promotion hook runs afterwards, on the query alone:
 * what it reports back is what the model is told became directly callable.
 *
 * @param args - The validated tool arguments.
 * @param registry - The gateway registry.
 * @param activateDirectTools - Optional promotion hook, invoked after a search.
 * @returns Text for the model.
 */
function handleSearch(
  args: ProxyArgs,
  registry: McpGatewayRegistry,
  activateDirectTools: SearchActivationHook | undefined,
): string {
  const options: { regex?: boolean; includeSchemas?: boolean; limit?: number; offset?: number } = {}
  if (args.regex !== undefined) options.regex = args.regex
  if (args.includeSchemas !== undefined) options.includeSchemas = args.includeSchemas
  if (args.limit !== undefined) options.limit = args.limit
  if (args.offset !== undefined) options.offset = args.offset
  const rendered = renderSearch(registry.search(args.search ?? '', options))
  const activated = activateDirectTools?.(
    args.search ?? '',
    args.regex === undefined ? {} : { regex: args.regex },
  )
  if (activated === undefined || activated.length === 0) return rendered
  return (
    `${rendered}\n\nNow callable directly as native tools: ${activated.join(', ')}. ` +
    'Their schemas are in your tool list from here on.'
  )
}

/**
 * `{ describe }`: the full schema of one named tool.
 *
 * @param args - The validated tool arguments.
 * @param registry - The gateway registry.
 * @param outputGuard - Optional bound on server-authored payloads.
 * @returns Text for the model.
 */
async function handleDescribe(
  args: ProxyArgs,
  registry: McpGatewayRegistry,
  outputGuard: OutputGuard | undefined,
): Promise<string> {
  const resolution = registry.describe(args.describe ?? '', args.server)
  if (resolution.kind === 'ok') {
    return guardServerText(
      renderDescribe(resolution.target.entry.serverName, resolution.target.tool),
      outputGuard,
    )
  }
  if (resolution.kind === 'ambiguous') {
    return (
      `"${args.describe}" exists on more than one server: ${resolution.candidates.join(', ')}. ` +
      `Add server to choose one.`
    )
  }
  if (resolution.kind === 'disabled') {
    return `Server "${resolution.entry.serverName}" is disabled in configuration.`
  }
  const hint = nearMissHint(
    resolution.suggestions,
    'Search with mcp({ search: "<keyword>" }) to find the exact name.',
  )
  return `No known tool named "${args.describe}". ${hint}`
}

/**
 * `{ instructions }`: a server's own usage notes, when it published any.
 *
 * @param args - The validated tool arguments.
 * @param registry - The gateway registry.
 * @param outputGuard - Optional bound on server-authored payloads.
 * @returns Text for the model.
 */
async function handleInstructions(
  args: ProxyArgs,
  registry: McpGatewayRegistry,
  outputGuard: OutputGuard | undefined,
): Promise<string> {
  const server = registry.servers.find(entry => entry.serverName === args.instructions)
  if (server === undefined) return renderUnknownServer(args.instructions, registry)
  const text = registry.instructions(args.instructions ?? '')
  if (text === undefined) {
    return `Server "${args.instructions}" published no usage instructions.`
  }
  return guardServerText(text, outputGuard)
}

/**
 * `{ connect }`: start one server on purpose and refresh its metadata.
 *
 * @param args - The validated tool arguments.
 * @param registry - The gateway registry.
 * @param signal - Cancellation signal.
 * @returns Text for the model.
 */
async function handleConnect(
  args: ProxyArgs,
  registry: McpGatewayRegistry,
  signal: AbortSignal | undefined,
): Promise<string> {
  const server = registry.servers.find(entry => entry.serverName === args.connect)
  if (server === undefined) return renderUnknownServer(args.connect, registry)
  try {
    // Explicit connect ignores the failure backoff: an operator who has just
    // fixed the command should not have to wait out the window.
    const catalog = await registry.ensureConnected(server, signal, { force: true })
    return (
      `Connected "${args.connect}" and refreshed its metadata: ${catalog.tools.length} ` +
      `tool${catalog.tools.length === 1 ? '' : 's'}. It will stop again after it sits idle.`
    )
  } catch (error) {
    return renderConnectFailure(args.connect ?? '', error)
  }
}

/**
 * `{ tool, args }`: resolve one tool, call it, render what came back.
 *
 * @param args - The validated tool arguments.
 * @param registry - The gateway registry.
 * @param signal - Cancellation signal.
 * @param outputGuard - Optional bound on server-authored payloads.
 * @returns Text for the model.
 */
async function handleCall(
  args: ProxyArgs,
  registry: McpGatewayRegistry,
  signal: AbortSignal | undefined,
  outputGuard: OutputGuard | undefined,
): Promise<string> {
  // A cold start knows nothing yet, so an unknown name is not a dead end: the
  // registry connects servers that have no catalog and looks again.
  const { resolution, failures } = await registry.discoverAndResolve(
    args.tool ?? '',
    args.server,
    signal,
  )
  if (resolution.kind === 'ambiguous') {
    return (
      `"${args.tool}" exists on more than one server: ${resolution.candidates.join(', ')}. ` +
      `Add server to choose one.`
    )
  }
  if (resolution.kind === 'disabled') {
    return `Server "${resolution.entry.serverName}" is disabled in configuration.`
  }
  if (resolution.kind === 'unknown') {
    const hint = nearMissHint(
      resolution.suggestions,
      'Use mcp({ search: "<keyword>" }) to find the exact name.',
    )
    const failed =
      failures.length === 0 ? '' : `\nServers that could not start: ${failures.join('; ')}`
    return `No known MCP tool named "${args.tool}". ${hint}${failed}`
  }
  try {
    const result = await registry.invoke(resolution.target, args.args ?? {}, signal)
    return guardServerText(
      renderToolResult(resolution.target.tool.qualifiedName, result),
      outputGuard,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return (
      `Calling "${resolution.target.tool.qualifiedName}" on server ` +
      `"${resolution.target.entry.serverName}" failed: ${message}`
    )
  }
}

/**
 * The "no such server" line, shared by the two actions that name one.
 *
 * @param serverName - The name the model asked for.
 * @param registry - The gateway registry.
 * @returns Text listing the servers that do exist.
 */
function renderUnknownServer(
  serverName: string | undefined,
  registry: McpGatewayRegistry,
): string {
  const known = registry.servers.map(entry => entry.serverName).join(', ') || '(none)'
  return `No server named "${serverName}". Configured: ${known}.`
}

/**
 * The near-miss tail of a resolution failure.
 *
 * The fallback sentence is a parameter because `describe` and `tool` have always
 * phrased it differently, and this refactor is not the place to change text the
 * model reads.
 *
 * @param suggestions - Near-miss names from the resolution.
 * @param whenNone - The sentence to use when there is no near miss.
 * @returns A sentence to append to the failure line.
 */
function nearMissHint(suggestions: readonly string[], whenNone: string): string {
  return suggestions.length === 0 ? whenNone : `Did you mean: ${suggestions.join(', ')}?`
}

/**
 * Dispatch one proxy call to the handler for its action.
 *
 * The gateway is one tool with many actions, so this *is* the plugin's public
 * behaviour: the order of these tests is the precedence between arguments, and a
 * call carrying none of them falls through to status. Each action lives in its
 * own function so one action's locals and early returns cannot be mistaken for
 * another's.
 *
 * @param args - The validated tool arguments.
 * @param registry - The gateway registry.
 * @param signal - Cancellation signal.
 * @param activateDirectTools - Optional promotion hook, invoked after a search.
 * @param outputGuard - Optional bound on server-authored payloads.
 * @param nativeServers - Co-mounted native servers, as a list or a getter.
 * @returns The canonical tool result value.
 */
async function executeProxy(
  args: ProxyArgs,
  registry: McpGatewayRegistry,
  signal: AbortSignal | undefined,
  activateDirectTools?: SearchActivationHook,
  outputGuard?: OutputGuard,
  nativeServers: NativeServersSource = [],
): Promise<string> {
  if (args.search !== undefined) return handleSearch(args, registry, activateDirectTools)
  if (args.describe !== undefined) return handleDescribe(args, registry, outputGuard)
  if (args.instructions !== undefined) return handleInstructions(args, registry, outputGuard)
  if (args.connect !== undefined) return handleConnect(args, registry, signal)
  if (args.tool !== undefined) return handleCall(args, registry, signal, outputGuard)
  return renderStatus(registry.status(), registry.cachePath, nativeServers, name =>
    registry.promotesNatively(name),
  )
}

/**
 * Called after a search, so optional native promotion can react to what the
 * model just looked at.
 *
 * Passed in rather than reached for globally: two gateway instances in one
 * process must not share promotion state.
 */
export type SearchActivationHook = (
  query: string,
  options: { regex?: boolean },
) => string[]

/**
 * Unwrap the argument envelope a gateway-named tool is dispatched with.
 *
 * A host that reserves a tool name for "call any tool" — `mcp` here, because
 * this gateway's whole purpose is to front every MCP server under that one name
 * — delivers arguments as `{ tool: "<the tool being called>", args: <its
 * arguments> }` rather than passing them straight through. Every other tool on
 * the host is affected the same way, and the host unwraps for its own tools.
 *
 * This plugin's tool is called `mcp`, so it collides with that reserved name and
 * receives the envelope. Left wrapped, `{ search: "x" }` arrives as
 * `{ tool: "mcp", args: { search: "x" } }`, the gateway reads `tool` as *a tool
 * to call on some MCP server*, and every call answers
 * `No known MCP tool named "mcp"` — the plugin looks installed and working while
 * being unable to do anything at all.
 *
 * The signature is unambiguous: the envelope's `tool` is this gateway's own name.
 * A caller meaning something else by `tool` is asking an MCP server for a tool
 * literally named `mcp`, which cannot exist — this gateway is the only `mcp`.
 *
 * @param args - The arguments as dispatched.
 * @returns The arguments the gateway should act on.
 */
export function unwrapGatewayEnvelope(
  args: ProxyArgs | Record<string, unknown>,
): ProxyArgs | Record<string, unknown> {
  const candidate = args as { tool?: unknown; args?: unknown }
  if (candidate.tool !== PROXY_TOOL_NAME) return args
  const inner = candidate.args
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return args
  return inner as Record<string, unknown>
}

/**
 * Build the proxy tool definition.
 *
 * @param registry - The gateway registry the tool delegates to.
 * @param activateDirectTools - Optional promotion hook, invoked after a search.
 * @param outputGuard - Optional bound on server-authored payloads.
 * @param nativeServers - Co-mounted native servers: a snapshot, or a getter the
 * tool calls each time it renders status. The getter is what keeps the conflict
 * notice honest when a patch layer changes without this plugin reloading.
 * @returns A registry-ready tool definition.
 */
export function createProxyTool(
  registry: McpGatewayRegistry,
  activateDirectTools?: SearchActivationHook,
  outputGuard?: OutputGuard,
  nativeServers: NativeServersSource = [],
): ToolDefinition {
  return defineTool({
    name: PROXY_TOOL_NAME,
    description: PROXY_TOOL_DESCRIPTION,
    parameters: PROXY_TOOL_PARAMETERS,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(dispatched, exec) {
      return executeProxy(
        unwrapGatewayEnvelope(dispatched) as ProxyArgs,
        registry,
        exec.signal,
        activateDirectTools,
        outputGuard,
        nativeServers,
      )
    },
    timeoutMs: 300_000,
  })
}
