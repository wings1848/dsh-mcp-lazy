/**
 * Model-facing tool identity and the exact proxy schema.
 *
 * The whole point of this plugin is that {@link PROXY_TOOL_NAME} and its
 * parameter schema are a **constant**: they are built once from a literal and
 * never depend on which servers are configured, connected, or discovered. The
 * tool-definition prefix of every request therefore stays byte-identical, which
 * is what keeps KV-cache reuse intact — the failure mode that dynamic
 * tool registration would otherwise introduce.
 *
 * @module dsh-mcp-lazy/schema
 */

/** The one model-facing tool this plugin registers. */
export const PROXY_TOOL_NAME = 'mcp'

/** Default number of `search` matches returned when `limit` is omitted. */
export const SEARCH_DEFAULT_LIMIT = 12

/** Hard ceiling on `search` matches per call, regardless of `limit`. */
export const SEARCH_MAX_LIMIT = 40

/** Default per-call timeout for one MCP `tools/call`, in milliseconds. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** Default idle-reap window in minutes; `0` disables idle reaping. */
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 10

/** Default metadata-cache age limit in milliseconds (7 days). */
export const DEFAULT_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Declared parameters of the proxy tool.
 *
 * Kept deliberately flat and small: this schema is the *only* MCP-related thing
 * in every request, so every property here is a permanent per-request cost.
 * Target is <= 400 tokens for the whole tool definition.
 */
export const PROXY_TOOL_PARAMETERS = {
  search: {
    type: 'string',
    description: 'Find tools by name or description. Answered from cache; starts no server.',
  },
  describe: {
    type: 'string',
    description: 'Show one tool\'s full parameter schema.',
  },
  tool: {
    type: 'string',
    description: 'Name of the MCP tool to call.',
  },
  args: {
    type: 'object',
    additionalProperties: true,
    description: 'Arguments for `tool`, matching the schema `describe` shows.',
  },
  server: {
    type: 'string',
    description: 'MCP server name; disambiguates a tool name shared by two servers.',
  },
  connect: {
    type: 'string',
    description: 'Start one server now and refresh its cached metadata, without calling a tool.',
  },
  instructions: {
    type: 'string',
    description: 'Show one server\'s own usage instructions, when it published any.',
  },
  regex: {
    type: 'boolean',
    description: 'Treat `search` as a regular expression.',
  },
  includeSchemas: {
    type: 'boolean',
    description: 'Include parameter summaries in `search` results. Defaults to true.',
  },
  limit: {
    type: 'integer',
    description: `Max \`search\` results. Defaults to ${SEARCH_DEFAULT_LIMIT}, capped at ${SEARCH_MAX_LIMIT}.`,
  },
  offset: {
    type: 'integer',
    description: 'Skip this many `search` results.',
  },
} as const
