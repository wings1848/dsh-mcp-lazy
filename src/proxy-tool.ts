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
import { McpGatewayRegistry, summarizeParameters } from './registry.js'
import { PROXY_TOOL_NAME, PROXY_TOOL_PARAMETERS } from './schema.js'
import type { ProjectedBlock, ServerStatus, ToolCallResult } from './types.js'

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
 * Render one non-text block as a line of diagnostic text.
 *
 * @param block - The projected block.
 * @returns A single line describing it.
 */
function renderBlock(block: ProjectedBlock): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'image':
      return `[image: ${block.mimeType}, ${block.bytes} bytes — this gateway returns text only, so the pixels are not forwarded]`
    case 'audio':
      return `[audio: ${block.mimeType}, ${block.bytes} bytes — not forwarded]`
    case 'resource_link':
      return `[resource: ${block.name === undefined ? block.uri : `${block.name} <${block.uri}>`}]`
    case 'unknown':
      return `[${block.detail}]`
  }
}

/**
 * Render one MCP tool result.
 *
 * A server-reported error is surfaced as an error, not a success: the call
 * happened, and pretending otherwise would teach the model the wrong lesson.
 *
 * @param toolName - The tool that was called, for the header.
 * @param result - The projected result.
 * @returns Text for the model.
 */
function renderToolResult(toolName: string, result: unknown): string {
  if (typeof result === 'string') return result
  if (typeof result !== 'object' || result === null) return JSON.stringify(result, null, 2)

  const projected = result as Partial<ToolCallResult>
  const blocks = Array.isArray(projected.blocks) ? projected.blocks : undefined
  if (blocks === undefined) {
    // Not one of ours — hand back the JSON rather than inventing a shape.
    return JSON.stringify(result, null, 2)
  }

  const body = blocks.map(renderBlock).filter(text => text !== '').join('\n')
  const structured =
    projected.structuredContent === undefined
      ? ''
      : `\n\n${JSON.stringify(projected.structuredContent, null, 2)}`

  if (projected.isError === true) {
    return `${toolName} reported an error:\n${body === '' ? '(no detail)' : body}`
  }
  return body === '' && structured === '' ? `${toolName} returned no content.` : `${body}${structured}`
}

/**
 * Render the status listing.
 *
 * @param servers - Per-server status snapshots.
 * @param cachePath - Where the metadata cache lives.
 * @returns Text for the model.
 */
function renderStatus(servers: readonly ServerStatus[], cachePath: string): string {
  if (servers.length === 0) {
    return 'No MCP servers are configured. Add entries under this plugin\'s `servers` config, then start a new session.'
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
 * Render the tool result as text, or as a structured error explanation.
 *
 * @param args - The validated tool arguments.
 * @param registry - The gateway registry.
 * @param signal - Cancellation signal.
 * @param activateDirectTools - Optional promotion hook, invoked after a search.
 * @param outputGuard - Optional bound on server-authored payloads.
 * @returns The canonical tool result value.
 */
async function executeProxy(
  args: ProxyArgs,
  registry: McpGatewayRegistry,
  signal: AbortSignal | undefined,
  activateDirectTools?: SearchActivationHook,
  outputGuard?: OutputGuard,
): Promise<string> {
  if (args.search !== undefined) {
    const options: { regex?: boolean; includeSchemas?: boolean; limit?: number; offset?: number } = {}
    if (args.regex !== undefined) options.regex = args.regex
    if (args.includeSchemas !== undefined) options.includeSchemas = args.includeSchemas
    if (args.limit !== undefined) options.limit = args.limit
    if (args.offset !== undefined) options.offset = args.offset
    const rendered = renderSearch(registry.search(args.search, options))
    const activated = activateDirectTools?.(args.search, args.regex === undefined ? {} : { regex: args.regex })
    if (activated === undefined || activated.length === 0) return rendered
    return (
      `${rendered}\n\nNow callable directly as native tools: ${activated.join(', ')}. ` +
      'Their schemas are in your tool list from here on.'
    )
  }

  if (args.describe !== undefined) {
    const resolution = registry.describe(args.describe, args.server)
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
    const hint =
      resolution.suggestions.length === 0
        ? 'Search with mcp({ search: "<keyword>" }) to find the exact name.'
        : `Did you mean: ${resolution.suggestions.join(', ')}?`
    return `No known tool named "${args.describe}". ${hint}`
  }

  if (args.instructions !== undefined) {
    const server = registry.servers.find(entry => entry.serverName === args.instructions)
    if (server === undefined) {
      return `No server named "${args.instructions}". Configured: ${registry.servers.map(entry => entry.serverName).join(', ') || '(none)'}.`
    }
    const text = registry.instructions(args.instructions)
    if (text === undefined) {
      return `Server "${args.instructions}" published no usage instructions.`
    }
    return guardServerText(text, outputGuard)
  }

  if (args.connect !== undefined) {
    const server = registry.servers.find(entry => entry.serverName === args.connect)
    if (server === undefined) {
      return `No server named "${args.connect}". Configured: ${registry.servers.map(entry => entry.serverName).join(', ') || '(none)'}.`
    }
    try {
      // Explicit connect ignores the failure backoff: an operator who has just
      // fixed the command should not have to wait out the window.
      const catalog = await registry.ensureConnected(server, signal, { force: true })
      return (
        `Connected "${args.connect}" and refreshed its metadata: ${catalog.tools.length} ` +
        `tool${catalog.tools.length === 1 ? '' : 's'}. It will stop again after it sits idle.`
      )
    } catch (error) {
      return renderConnectFailure(args.connect, error)
    }
  }

  if (args.tool !== undefined) {
    // A cold start knows nothing yet, so an unknown name is not a dead end: the
    // registry connects servers that have no catalog and looks again.
    const { resolution, failures } = await registry.discoverAndResolve(args.tool, args.server, signal)
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
      const hint =
        resolution.suggestions.length === 0
          ? 'Use mcp({ search: "<keyword>" }) to find the exact name.'
          : `Did you mean: ${resolution.suggestions.join(', ')}?`
      const failed = failures.length === 0 ? '' : `\nServers that could not start: ${failures.join('; ')}`
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

  return renderStatus(registry.status(), registry.cachePath)
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
 * Build the proxy tool definition.
 *
 * @param registry - The gateway registry the tool delegates to.
 * @param activateDirectTools - Optional promotion hook, invoked after a search.
 * @param outputGuard - Optional bound on server-authored payloads.
 * @returns A registry-ready tool definition.
 */
export function createProxyTool(
  registry: McpGatewayRegistry,
  activateDirectTools?: SearchActivationHook,
  outputGuard?: OutputGuard,
): ToolDefinition {
  return defineTool({
    name: PROXY_TOOL_NAME,
    description: PROXY_TOOL_DESCRIPTION,
    parameters: PROXY_TOOL_PARAMETERS,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      return executeProxy(args as ProxyArgs, registry, exec.signal, activateDirectTools, outputGuard)
    },
    timeoutMs: 300_000,
  })
}
