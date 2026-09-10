/**
 * Deterministic naming for MCP tools.
 *
 * Public tool names are a **pure function of `(serverName, originalName)`** and
 * satisfy the DeepSeek function-name contract (64 characters, `[A-Za-z0-9_-]`).
 * The clean case is `serverName__originalName` verbatim; when replacement or
 * truncation changes it, a 12-hex-character SHA-256 prefix of the identity is
 * appended so two distinct MCP identities can never collapse into one name.
 *
 * This mirrors `publicToolName()` from `@deepseek-ai/dsh-mcp-client` — same
 * algorithm, minus its `mcp__` wire prefix, which this plugin does not need
 * because it does not register a tool per MCP tool.
 *
 * The original name is the only name ever sent to the server; a qualified name
 * is never parsed back to recover it.
 *
 * @module dsh-mcp-lazy/naming
 */

import { createHash } from 'node:crypto'
import type { ServerEntry, ToolMetadata } from './types.js'

/** Longest accepted model-facing function name. */
export const MAX_FUNCTION_NAME_LENGTH = 64

/** Separator between the server namespace and the server's own tool name. */
export const NAME_SEPARATOR = '__'

/**
 * Derive the model-facing qualified name for one MCP tool.
 *
 * @param serverName - Stable local namespace from the server entry.
 * @param originalName - The server's own tool name.
 * @returns A unique name satisfying the function-name contract.
 */
export function qualifiedToolName(serverName: string, originalName: string): string {
  const identity = `${serverName}${NAME_SEPARATOR}${originalName}`
  const cleaned = identity.replace(/[^A-Za-z0-9_-]/g, '_')
  if (cleaned === identity && cleaned.length <= MAX_FUNCTION_NAME_LENGTH) return cleaned
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 12)
  const room = MAX_FUNCTION_NAME_LENGTH - hash.length - 1
  return `${cleaned.slice(0, Math.max(room, 0))}_${hash}`
}

/**
 * Match one tool name or glob against a candidate name.
 *
 * `*` matches any run of characters; everything else is literal. Matching is
 * case-insensitive so a config written against a server's documented casing
 * keeps working after it renames to a different case.
 *
 * @param pattern - Configured name or glob.
 * @param candidate - Candidate tool name.
 * @returns Whether the pattern matches.
 */
export function matchesNamePattern(pattern: string, candidate: string): boolean {
  if (pattern === candidate) return true
  if (!pattern.includes('*')) return pattern.toLowerCase() === candidate.toLowerCase()
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i').test(candidate)
}

/**
 * Apply `includeTools` / `excludeTools` to one tool.
 *
 * Include is checked first; exclude then wins. A pattern may name the server's
 * own tool name, the qualified name, or just the part after the server prefix —
 * so `read_*`, `srv__read_*`, and `read_file` all address the same tool.
 *
 * @param tool - Candidate tool metadata.
 * @param entry - Server entry carrying the filters.
 * @returns Whether the tool survives filtering.
 */
export function isToolAllowed(
  tool: ToolMetadata,
  entry: Pick<ServerEntry, 'includeTools' | 'excludeTools'>,
): boolean {
  const candidates = toolCandidates(tool)
  const includes = entry.includeTools
  if (includes !== undefined && includes.length > 0) {
    const hit = includes.some(pattern => candidates.some(name => matchesNamePattern(pattern, name)))
    if (!hit) return false
  }
  const excludes = entry.excludeTools
  if (excludes !== undefined && excludes.length > 0) {
    const hit = excludes.some(pattern => candidates.some(name => matchesNamePattern(pattern, name)))
    if (hit) return false
  }
  return true
}

/**
 * Every spelling a configured pattern may address one tool by.
 *
 * @param tool - Tool metadata.
 * @returns The server's own name, the qualified name, and the unqualified tail.
 */
export function toolCandidates(tool: ToolMetadata): string[] {
  const separator = tool.qualifiedName.indexOf(NAME_SEPARATOR)
  const tail =
    separator === -1 ? tool.qualifiedName : tool.qualifiedName.slice(separator + NAME_SEPARATOR.length)
  return [...new Set([tool.originalName, tool.qualifiedName, tail])]
}

/**
 * Resolve the extra search keywords configured for one tool.
 *
 * Keys match by original name or qualified name, or as a glob, reusing the same
 * matcher as the include/exclude filters; every matching entry contributes.
 *
 * @param tool - Candidate tool metadata.
 * @param searchKeywords - The server entry's keyword map.
 * @returns The union of matching keyword lists, or an empty array.
 */
export function resolveSearchKeywords(
  tool: ToolMetadata,
  searchKeywords: Record<string, string[]> | undefined,
): string[] {
  if (searchKeywords === undefined) return []
  const candidates = toolCandidates(tool)
  const out: string[] = []
  for (const [pattern, words] of Object.entries(searchKeywords)) {
    if (!candidates.some(name => matchesNamePattern(pattern, name))) continue
    for (const word of words) if (!out.includes(word)) out.push(word)
  }
  return out
}
