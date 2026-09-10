/**
 * Optional native-tool promotion.
 *
 * The gateway's default shape — one tool, forever — is what keeps the request
 * prefix stable. `directTools` exists for the cases where that generality costs
 * more than it saves: a handful of tools called constantly, where the extra hop
 * through the proxy is pure overhead.
 *
 * Promotion is deliberately *not* the default and deliberately not automatic:
 *
 * - `true` / `string[]` register the selected tools natively at first
 *   opportunity. The model-facing surface grows, and the request prefix changes.
 * - `'search'` registers nothing up front. Tools become native only once
 *   `mcp({ search })` has actually matched them, so a session that never searches
 *   never pays for the change.
 * - `freezeDirectTools` stops promotion after the first pass, which bounds the
 *   prefix churn to a single event even if the server keeps editing its catalog.
 *
 * @module dsh-mcp-lazy/direct-tools
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { OutputGuard } from './output-guard.js'
import { McpGatewayRegistry } from './registry.js'
import { summarizeParameters } from './registry.js'
import type { ProjectedBlock, ServerEntry, ToolCallResult, ToolMetadata } from './types.js'

/** How many native tools have been registered, for status and callers. */
export interface DirectToolState {
  /** Qualified names currently registered natively. */
  registered: Set<string>
  /** Qualified names staged by `'search'` mode but not yet matched. */
  staged: Set<string>
  /** Set once promotion has stopped accepting new tools. */
  frozen: boolean
}

/**
 * Render one non-text block as text, matching the proxy's projection.
 *
 * @param block - The projected block.
 * @returns One line of text.
 */
function renderBlock(block: ProjectedBlock): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'image':
      return `[image: ${block.mimeType}, ${block.bytes} bytes — not forwarded]`
    case 'audio':
      return `[audio: ${block.mimeType}, ${block.bytes} bytes — not forwarded]`
    case 'resource_link':
      return `[resource: ${block.name === undefined ? block.uri : `${block.name} <${block.uri}>`}]`
    case 'unknown':
      return `[${block.detail}]`
  }
}

/**
 * Render a native tool's result.
 *
 * @param toolName - The tool that ran.
 * @param result - The live result.
 * @returns Text for the model.
 */
function renderNativeResult(toolName: string, result: unknown): string {
  if (typeof result === 'string') return result
  const projected = result as Partial<ToolCallResult>
  if (!Array.isArray(projected.blocks)) return JSON.stringify(result, null, 2)
  const body = projected.blocks.map(renderBlock).filter(text => text !== '').join('\n')
  if (projected.isError === true) return `${toolName} reported an error:\n${body || '(no detail)'}`
  return body === '' ? `${toolName} returned no content.` : body
}

/**
 * Convert one advertised JSON Schema node into the harness's parameter DSL.
 *
 * The harness builds tool definitions from its own DSL rather than raw JSON
 * Schema, so a promoted MCP tool has to be translated. The translation is
 * lossy in exactly one direction and that is deliberate: a construct the DSL
 * cannot express (`anyOf`, `$ref`, `not`, tuple `items`, …) degrades to
 * unconstrained JSON instead of guessing at a narrower type.
 *
 * Guessing would be worse than being permissive. A promoted tool whose schema
 * under-declares a parameter silently rejects the model's correct call; one that
 * over-declares merely accepts an argument the server will judge for itself.
 *
 * @param node - One advertised schema node.
 * @returns The DSL property spec for it.
 */
function toValueSpec(node: unknown): Record<string, unknown> {
  if (typeof node !== 'object' || node === null) return { type: 'json' }
  const raw = node as Record<string, unknown>
  const spec: Record<string, unknown> = {}
  if (typeof raw['description'] === 'string') spec['description'] = raw['description']
  if (typeof raw['title'] === 'string') spec['title'] = raw['title']

  switch (raw['type']) {
    case 'string':
      spec['type'] = 'string'
      if (isScalarArray(raw['enum'])) spec['enum'] = raw['enum']
      if (typeof raw['const'] === 'string') spec['const'] = raw['const']
      return spec
    case 'number':
    case 'integer':
      spec['type'] = raw['type']
      if (isScalarArray(raw['enum'])) spec['enum'] = raw['enum']
      if (typeof raw['const'] === 'number') spec['const'] = raw['const']
      return spec
    case 'boolean':
      spec['type'] = 'boolean'
      if (typeof raw['const'] === 'boolean') spec['const'] = raw['const']
      return spec
    case 'null':
      spec['type'] = 'null'
      return spec
    case 'array': {
      spec['type'] = 'array'
      // Tuple-style `items` (an array) has no DSL equivalent; leave items open.
      if (raw['items'] !== undefined && !Array.isArray(raw['items'])) {
        spec['items'] = toValueSpec(raw['items'])
      }
      return spec
    }
    case 'object': {
      spec['type'] = 'object'
      spec['additionalProperties'] = raw['additionalProperties'] === false ? false : true
      const properties = raw['properties']
      if (typeof properties === 'object' && properties !== null && !Array.isArray(properties)) {
        const required = new Set(
          Array.isArray(raw['required'])
            ? raw['required'].filter((name): name is string => typeof name === 'string')
            : [],
        )
        const nested: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
          const child = toValueSpec(value)
          if (required.has(key)) child['required'] = true
          nested[key] = child
        }
        if (Object.keys(nested).length > 0) spec['properties'] = nested
      }
      return spec
    }
    default: {
      // Exact-one unions survive as `oneOf`; anything else becomes free JSON.
      const oneOf = raw['oneOf']
      if (Array.isArray(oneOf) && oneOf.length >= 2) {
        spec['oneOf'] = oneOf.map(branch => toValueSpec(branch))
        return spec
      }
      return { type: 'json' }
    }
  }
}

/** Whether a value is an array of JSON scalars, as `enum` requires. */
function isScalarArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      item => item === null || ['string', 'number', 'boolean'].includes(typeof item),
    )
  )
}

/**
 * Convert an advertised parameter object into DSL properties.
 *
 * @param inputSchema - The server's advertised input schema.
 * @returns Property specs plus the names the server marked required.
 */
export function toParameterSpec(inputSchema: unknown): {
  properties: Record<string, unknown>
  required: string[]
} {
  if (typeof inputSchema !== 'object' || inputSchema === null) return { properties: {}, required: [] }
  const raw = inputSchema as Record<string, unknown>
  const advertised = raw['properties']
  if (typeof advertised !== 'object' || advertised === null || Array.isArray(advertised)) {
    // A schema with no declared properties but an open object still accepts
    // arbitrary arguments, which is what `additionalProperties` in the proxy
    // already models; an empty property map keeps the tool callable.
    return { properties: {}, required: [] }
  }
  const required = new Set(
    Array.isArray(raw['required'])
      ? raw['required'].filter((name): name is string => typeof name === 'string')
      : [],
  )
  const properties: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(advertised as Record<string, unknown>)) {
    const spec = toValueSpec(value)
    if (required.has(key)) spec['required'] = true
    properties[key] = spec
  }
  return { properties, required: [...required] }
}

/**
 * Build the native definition for one promoted MCP tool.
 *
 * The parameters are the server's own advertised schema, passed through
 * verbatim: a promoted tool is a real tool, and paraphrasing its schema would
 * make it a worse one.
 *
 * @param registry - The gateway registry, for invoking.
 * @param entry - The owning server entry.
 * @param tool - The tool to promote.
 * @param outputGuard - Optional bound on the server-authored result.
 * @returns A registry-ready tool definition.
 */
export function createNativeTool(
  registry: McpGatewayRegistry,
  entry: ServerEntry,
  tool: ToolMetadata,
  outputGuard?: OutputGuard,
): ToolDefinition {
  const summary = summarizeParameters(tool.inputSchema)
  const description = [
    tool.description === '' ? `${tool.originalName} (from the ${entry.serverName} MCP server).` : tool.description,
    `MCP server: ${entry.serverName}.`,
    summary === undefined ? '' : `Parameters: ${summary}`,
  ]
    .filter(line => line !== '')
    .join(' ')

  return defineTool({
    name: tool.qualifiedName,
    description,
    // The harness builds definitions from its own DSL, so the server's JSON
    // Schema is translated rather than cast; see `toValueSpec`.
    parameters: toParameterSpec(tool.inputSchema)['properties'] as never,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      try {
        const result = await registry.invoke(
          { entry, tool },
          (args ?? {}) as Record<string, unknown>,
          exec.signal,
        )
        const rendered = renderNativeResult(tool.qualifiedName, result)
        // A promoted tool is a first-class tool, so it has to honour the same
        // output ceiling as the proxy path — otherwise promotion becomes a way
        // to bypass it.
        if (outputGuard === undefined) return rendered
        return (await outputGuard.guard(rendered)).text
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return `Calling "${tool.qualifiedName}" failed: ${message}`
      }
    },
    timeoutMs: 300_000,
  })
}

/**
 * Manage native promotion for one gateway.
 *
 * Registration happens through the supplied `register` callback so this module
 * never needs the tool runtime, which keeps it testable without a host.
 */
export class DirectToolRegistrar {
  readonly #registry: McpGatewayRegistry
  readonly #register: (definition: ToolDefinition) => () => void
  readonly #state: DirectToolState = {
    registered: new Set(),
    staged: new Set(),
    frozen: false,
  }
  readonly #disposers = new Map<string, () => void>()
  /** Why a promotion failed, keyed by qualified name. */
  readonly #failures = new Map<string, string>()
  /** Stop promoting after the first pass. */
  readonly #freeze: boolean
  /** Optional bound applied to every promoted tool's result. */
  readonly #outputGuard: OutputGuard | undefined

  /**
   * @param registry - The gateway registry.
   * @param register - Registers one definition and returns its disposer.
   * @param freeze - Stop promoting after the first pass.
   * @param outputGuard - Optional bound applied to every promoted tool's result.
   */
  constructor(
    registry: McpGatewayRegistry,
    register: (definition: ToolDefinition) => () => void,
    freeze = false,
    outputGuard?: OutputGuard,
  ) {
    this.#registry = registry
    this.#register = register
    this.#freeze = freeze
    this.#outputGuard = outputGuard
  }

  /** Current promotion state. */
  get state(): DirectToolState {
    return this.#state
  }

  /** Promotions that could not be registered, with their reasons. */
  get failures(): ReadonlyMap<string, string> {
    return this.#failures
  }

  /**
   * Register everything configuration asks for right now.
   *
   * Called after any catalog change. In `'search'` mode this only *stages*
   * names: staging is bookkeeping, and the model sees nothing until a search
   * matches one.
   *
   * @returns The qualified names registered by this call.
   */
  sync(): string[] {
    if (this.#freeze && this.#state.frozen) return []
    const added: string[] = []

    for (const selection of this.#registry.directToolSelections()) {
      for (const tool of selection.tools) {
        if (this.#registerOne(selection.serverName, tool)) added.push(tool.qualifiedName)
      }
    }

    for (const serverName of this.#registry.searchModeServers()) {
      for (const tool of this.#registry.toolsOf(serverName)) {
        if (this.#state.registered.has(tool.qualifiedName)) continue
        this.#state.staged.add(tool.qualifiedName)
        this.#stagedTools.set(tool.qualifiedName, { serverName, tool })
      }
    }

    if (added.length > 0 || this.#freeze) this.#state.frozen = true
    return added
  }

  /** Staged tools, keyed by qualified name, so activation needs no re-lookup. */
  readonly #stagedTools = new Map<string, { serverName: string; tool: ToolMetadata }>()

  /**
   * Activate the staged tools a search just matched.
   *
   * @param query - The query the model ran.
   * @param options - Regex mode, so activation mirrors what was displayed.
   * @returns The qualified names that became native tools.
   */
  activateFromSearch(query: string, options: { regex?: boolean } = {}): string[] {
    const matched = this.#registry.matchesForActivation(query, options)
    const added: string[] = []
    for (const { entry, tool } of matched) {
      if (this.#registerOne(entry.serverName, tool)) added.push(tool.qualifiedName)
    }
    return added
  }

  /**
   * Register one tool if it is not already native.
   *
   * @param serverName - The owning server.
   * @param tool - The tool to promote.
   * @returns Whether it was newly registered.
   */
  #registerOne(serverName: string, tool: ToolMetadata): boolean {
    if (this.#state.registered.has(tool.qualifiedName)) return false
    const entry = this.#registry.servers.find(server => server.serverName === serverName)
    if (entry === undefined) return false
    try {
      const disposer = this.#register(createNativeTool(this.#registry, entry, tool, this.#outputGuard))
      this.#disposers.set(tool.qualifiedName, disposer)
      this.#state.registered.add(tool.qualifiedName)
      this.#state.staged.delete(tool.qualifiedName)
      return true
    } catch (error) {
      // A conflicting or invalid definition must not break the proxy, which
      // remains the reliable path to every tool. The reason is kept so a caller
      // can report why a configured promotion never appeared.
      this.#failures.set(tool.qualifiedName, error instanceof Error ? error.message : String(error))
      return false
    }
  }

  /** Forget every native registration. */
  dispose(): void {
    for (const disposer of this.#disposers.values()) {
      try {
        disposer()
      } catch {
        // Disposal is best-effort; the host tears the scope down anyway.
      }
    }
    this.#disposers.clear()
    this.#state.registered.clear()
    this.#state.staged.clear()
  }
}
