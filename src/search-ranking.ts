/**
 * Weighted search ranking for `mcp({ search })`.
 *
 * The scoring model is ported from `pi-mcp-adapter` (`search-ranking.ts`): a
 * whole-field phrase hit is worth far more than a token hit buried in prose, a
 * match on a tool's own name outranks a match in its description, and a query
 * of more than two tokens is allowed to match on partial coverage so that a
 * slightly-over-specified query still finds the tool the model meant.
 *
 * Two details carry more weight than they look:
 *
 * - {@link normalizeSearchText} splits camelCase, so `getPixels` tokenizes to
 *   `get` + `pixels` and a search for `pixels` finds it. Without that split the
 *   name is one opaque token and only an exact-name query matches.
 * - Tokens that are too short to be meaningful (`MIN_STEM_LENGTH`) never
 *   stem-match, so the `s` produced by tokenizing a possessive cannot make every
 *   query starting with `s` match everything.
 *
 * Keywords supplied through `searchKeywords` participate in ranking only. They
 * are never written to a schema, a description, or the metadata cache.
 *
 * @module dsh-mcp-lazy/search-ranking
 */

import { resolveSearchKeywords } from './naming.js'
import type { ServerEntry, ToolMetadata } from './types.js'

/**
 * Shortest field token allowed to stem-match a longer query token.
 *
 * Below this, a one- or two-letter fragment would match unrelated text.
 */
export const MIN_STEM_LENGTH = 4

/** Relative weight of each searchable field. Declaration order is score order. */
export const FIELD_WEIGHTS = {
  qualifiedName: 12,
  originalName: 10,
  server: 8,
  description: 5,
  keywords: 5,
} as const

/** One searchable field of a tool. */
export type SearchField = keyof typeof FIELD_WEIGHTS

/** One candidate tool prepared for scoring. */
export interface ToolDocument {
  serverName: string
  tool: ToolMetadata
  /** Lower-cased qualified name, for deterministic tie-breaking. */
  needle: string
  /** Normalized fields in {@link FIELD_WEIGHTS} order. */
  fields: ToolDocumentField[]
  /** Tokens of the qualified name, for the first-token bonus. */
  nameTokens: string[]
  /** Whole keyword phrases, for phrase-level matching. */
  keywordPhrases: string[]
  /** Tokens across every keyword phrase. */
  keywordTokens: string[]
}

/** One normalized searchable field. */
export interface ToolDocumentField {
  field: SearchField
  /** Normalized whole field, for phrase comparison. */
  value: string
  /** Normalized tokens of the field. */
  tokens: string[]
}

/** One scored match. */
export interface RankedToolMatch {
  serverName: string
  tool: ToolMetadata
  score: number
}

/**
 * Normalize text for matching: split camelCase, lower-case, collapse runs of
 * punctuation into single spaces.
 *
 * The camelCase split runs first and before lower-casing, because the boundary
 * it looks for (`aB`) is destroyed by lower-casing. Punctuation handling stays
 * Unicode-aware rather than ASCII-only, so a tool name written in a non-Latin
 * script still tokenizes instead of vanishing.
 *
 * @param value - Raw text.
 * @returns Normalized text with single spaces between tokens.
 */
export function normalizeSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * Split already-normalized text into tokens.
 *
 * @param normalized - Text from {@link normalizeSearchText}.
 * @returns The token list, empty when the text has no word characters.
 */
function splitTokens(normalized: string): string[] {
  return normalized === '' ? [] : normalized.split(' ').filter(token => token !== '')
}

/**
 * Split text into normalized tokens.
 *
 * @param value - Raw text.
 * @returns The token list, empty when the text has no word characters.
 */
export function tokenize(value: string): string[] {
  return splitTokens(normalizeSearchText(value))
}

/**
 * Build the searchable document for one tool.
 *
 * @param serverName - The owning server's name.
 * @param tool - The tool metadata.
 * @param entry - The server entry, for `searchKeywords`.
 * @returns The prepared document.
 */
export function buildToolDocument(
  serverName: string,
  tool: ToolMetadata,
  entry: Pick<ServerEntry, 'searchKeywords'>,
): ToolDocument {
  const byField: Record<Exclude<SearchField, 'keywords'>, string> = {
    qualifiedName: normalizeSearchText(tool.qualifiedName),
    originalName: normalizeSearchText(tool.originalName),
    server: normalizeSearchText(serverName),
    description: normalizeSearchText(tool.description),
  }
  const fields = (Object.keys(byField) as Exclude<SearchField, 'keywords'>[]).map(field => ({
    field: field as SearchField,
    value: byField[field],
    tokens: splitTokens(byField[field]),
  }))

  const keywordPhrases = resolveSearchKeywords(tool, entry.searchKeywords)
    .map(keyword => normalizeSearchText(keyword))
    .filter(keyword => keyword !== '')

  return {
    serverName,
    tool,
    needle: tool.qualifiedName.toLowerCase(),
    fields,
    nameTokens: fields[0]?.tokens ?? [],
    keywordPhrases,
    keywordTokens: keywordPhrases.flatMap(splitTokens),
  }
}

/** Tokens of one field, or an empty list when the document has no such field. */
function fieldTokens(document: ToolDocument, field: SearchField): string[] {
  return document.fields.find(entry => entry.field === field)?.tokens ?? []
}

/**
 * Score one document against a query.
 *
 * Each field contributes independently: a whole-field phrase hit scores at
 * `weight * 14`, a field that merely starts with the query at `* 9`, a
 * substring hit at `* 6`, and per query token an exact token hit at `* 4`, a
 * stem hit at `* 2`, and a raw substring hit at `* 1`.
 *
 * The document then qualifies or not — a phrase hit always qualifies, a short
 * query must match every token, and a longer query needs at least 60% coverage.
 * Requiring every token of a long query would reject tools that are plainly the
 * right answer; accepting any single token would return everything.
 *
 * @param document - The prepared document.
 * @param query - Raw query text.
 * @returns The score, or `null` when the document does not match.
 */
export function scoreToolMatch(document: ToolDocument, query: string): number | null {
  const normalizedQuery = normalizeSearchText(query)
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return null

  let score = 0
  let phraseMatched = false
  let wholeFieldExact = false
  const matchedTokens = new Set<string>()

  for (const { field, value, tokens } of document.fields) {
    const weight = FIELD_WEIGHTS[field]
    if (value === normalizedQuery) {
      score += weight * 14
      phraseMatched = true
      wholeFieldExact = true
    } else if (value.startsWith(normalizedQuery)) {
      score += weight * 9
      phraseMatched = true
    } else if (value.includes(normalizedQuery)) {
      score += weight * 6
      phraseMatched = true
    }

    for (const token of queryTokens) {
      if (tokens.includes(token)) {
        score += weight * 4
        matchedTokens.add(token)
      } else if (
        tokens.some(
          fieldToken =>
            fieldToken.startsWith(token) ||
            (fieldToken.length >= MIN_STEM_LENGTH && token.startsWith(fieldToken)),
        )
      ) {
        score += weight * 2
        matchedTokens.add(token)
      } else if (value.includes(token)) {
        score += weight
        matchedTokens.add(token)
      }
    }
  }

  // Configured keywords are discrete phrases, so the phrase bonus is computed
  // per phrase with best-match-wins rather than on one joined string, which
  // would phrase-match a query spanning two unrelated keywords.
  if (document.keywordPhrases.length > 0) {
    const weight = FIELD_WEIGHTS.keywords
    let phraseScore = 0
    for (const phrase of document.keywordPhrases) {
      if (phrase === normalizedQuery) {
        phraseScore = Math.max(phraseScore, weight * 14)
        phraseMatched = true
        wholeFieldExact = true
      } else if (phrase.startsWith(normalizedQuery)) {
        phraseScore = Math.max(phraseScore, weight * 9)
        phraseMatched = true
      } else if (phrase.includes(normalizedQuery)) {
        phraseScore = Math.max(phraseScore, weight * 6)
        phraseMatched = true
      }
    }
    score += phraseScore

    for (const token of queryTokens) {
      if (document.keywordTokens.includes(token)) {
        score += weight * 4
        matchedTokens.add(token)
      } else if (
        document.keywordTokens.some(
          keywordToken =>
            keywordToken.startsWith(token) ||
            (keywordToken.length >= MIN_STEM_LENGTH && token.startsWith(keywordToken)),
        )
      ) {
        score += weight * 2
        matchedTokens.add(token)
      } else if (document.keywordPhrases.some(phrase => phrase.includes(token))) {
        score += weight
        matchedTokens.add(token)
      }
    }
  }

  const coverage = matchedTokens.size / queryTokens.length
  if (!phraseMatched && (queryTokens.length <= 2 ? coverage !== 1 : coverage < 0.6)) return null

  score += coverage === 1 ? 25 : Math.round(coverage * 10)
  const firstQueryToken = queryTokens[0]
  if (firstQueryToken !== undefined && document.nameTokens.includes(firstQueryToken)) score += 8
  if (wholeFieldExact) score += 20
  return score
}

/**
 * Rank every candidate against a query.
 *
 * Ties break on the qualified name so the same query always returns the same
 * order — a stable tool list is what keeps the proxy's own output deterministic.
 *
 * @param documents - Candidate documents.
 * @param query - Raw query text.
 * @returns Matches sorted best-first.
 */
export function rankToolMatches(documents: readonly ToolDocument[], query: string): RankedToolMatch[] {
  const matches: RankedToolMatch[] = []
  for (const document of documents) {
    const score = scoreToolMatch(document, query)
    if (score === null) continue
    matches.push({ serverName: document.serverName, tool: document.tool, score })
  }
  return matches.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    return left.tool.qualifiedName.localeCompare(right.tool.qualifiedName)
  })
}

/** Longest regular expression accepted for `mcp({ search, regex: true })`. */
export const MAX_REGEX_QUERY_LENGTH = 256

/**
 * Whether a pattern nests one unbounded quantifier inside another.
 *
 * This is the shape that makes backtracking exponential rather than merely
 * slow: `(a+)+c` against a run of `a`s with no `c` explores every way of
 * splitting the run, doubling the work per extra character. Measured on this
 * code base, 24 characters cost ~130 ms and 28 cost ~2 s.
 *
 * The check is a conservative structural scan, not a proof. It recognises an
 * unbounded quantifier (`*`, `+`, `{n,}`) inside a group that is itself
 * unboundedly quantified. It deliberately does **not** try to catch every
 * super-linear pattern — overlapping alternation such as `(a|aa)+` and
 * polynomial blowups such as `a*a*a*b` pass. pi-mcp-adapter runs the `recheck`
 * analyzer here; this plugin keeps its single-dependency footprint and accepts
 * a narrower guarantee, which is why the limit is documented rather than
 * implied.
 *
 * @param pattern - The regular expression source.
 * @returns True when the pattern nests unbounded quantifiers.
 */
function hasNestedQuantifier(pattern: string): boolean {
  const stack: { unbounded: boolean }[] = []
  let escaped = false
  let inClass = false

  for (let index = 0; index < pattern.length; index += 1) {
    const ch = pattern[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (inClass) {
      if (ch === ']') inClass = false
      continue
    }
    if (ch === '[') {
      inClass = true
      continue
    }
    if (ch === '(') {
      stack.push({ unbounded: false })
      continue
    }
    if (ch === ')') {
      const group = stack.pop()
      if (group === undefined) continue
      const next = pattern[index + 1]
      const braced = next === '{' ? /^\{\d*,\d*\}/.exec(pattern.slice(index + 1)) : null
      const quantified = next === '*' || next === '+' || (braced !== null && braced[0].includes(','))
      if (!quantified) continue
      if (group.unbounded) return true
      const parent = stack[stack.length - 1]
      if (parent !== undefined) parent.unbounded = true
      continue
    }
    if (ch === '*' || ch === '+') {
      const top = stack[stack.length - 1]
      if (top !== undefined) top.unbounded = true
      continue
    }
    if (ch === '{') {
      const braced = /^\{\d*,\d*\}/.exec(pattern.slice(index))
      if (braced === null) continue
      index += braced[0].length - 1
      if (!braced[0].includes(',')) continue
      const top = stack[stack.length - 1]
      if (top !== undefined) top.unbounded = true
    }
  }
  return false
}

/**
 * Evaluate a regular expression against every candidate.
 *
 * The pattern comes straight from the model, so every rejection is reported as
 * a value rather than thrown, and the three ways a pattern can be refused — too
 * long, syntactically invalid, or liable to backtrack exponentially — carry
 * distinct messages the caller can show verbatim.
 *
 * @param documents - Candidate documents.
 * @param pattern - The regular expression source.
 * @returns Either the matches or the pattern error.
 */
export function regexToolMatches(
  documents: readonly ToolDocument[],
  pattern: string,
): { matches: RankedToolMatch[] } | { error: string } {
  if (pattern.length > MAX_REGEX_QUERY_LENGTH) {
    return {
      error:
        `Regular expression is too long (${pattern.length} characters; ` +
        `the limit is ${MAX_REGEX_QUERY_LENGTH}).`,
    }
  }
  if (hasNestedQuantifier(pattern)) {
    return {
      error:
        'Regular expression nests repeated quantifiers (such as `(a+)+`), which can ' +
        'backtrack exponentially. Simplify it, or search by name instead.',
    }
  }

  let expression: RegExp
  try {
    expression = new RegExp(pattern, 'i')
  } catch (error) {
    // `new RegExp` already phrases its SyntaxError as "Invalid regular
    // expression: …", so the message is passed through rather than prefixed.
    const message = error instanceof Error ? error.message : String(error)
    return { error: message }
  }

  const matches: RankedToolMatch[] = []
  for (const document of documents) {
    const haystack = [
      document.tool.qualifiedName,
      document.tool.description,
      ...document.keywordPhrases,
    ].join('\n')
    if (!expression.test(haystack)) continue
    matches.push({ serverName: document.serverName, tool: document.tool, score: 1 })
  }
  return {
    matches: matches.sort((left, right) => left.tool.qualifiedName.localeCompare(right.tool.qualifiedName)),
  }
}

/**
 * Page a result list.
 *
 * @param items - The full result list.
 * @param offset - Items to skip; negative values are treated as 0.
 * @param limit - Maximum items to return.
 * @returns The page plus paging metadata for the next call.
 */
export function paginate<T>(
  items: readonly T[],
  offset: number,
  limit: number,
): { items: T[]; total: number; hasMore: boolean; nextOffset: number | null } {
  const safeOffset = Math.max(0, Math.trunc(offset))
  const safeLimit = Math.max(0, Math.trunc(limit))
  const page = items.slice(safeOffset, safeOffset + safeLimit)
  const nextOffset = safeOffset + page.length
  const hasMore = nextOffset < items.length
  return { items: page, total: items.length, hasMore, nextOffset: hasMore ? nextOffset : null }
}

/**
 * Suggest near-miss tool names for an unknown tool.
 *
 * Ranking reuses the normal scorer against the unmatched name, so the
 * suggestions are the tools the model most likely meant.
 *
 * @param documents - Candidate documents.
 * @param name - The name the caller asked for.
 * @param limit - Maximum suggestions.
 * @returns Suggested qualified names, best first.
 */
export function rankSuggestions(
  documents: readonly ToolDocument[],
  name: string,
  limit = 5,
): string[] {
  const direct = rankToolMatches(documents, name).slice(0, limit).map(match => match.tool.qualifiedName)
  if (direct.length > 0) return direct

  // Fall back to token overlap on the original name, so `create_issue` still
  // suggests `create_pull_request` when the exact tokens do not line up.
  const queryTokens = new Set(tokenize(name))
  return documents
    .map(document => {
      const overlap = fieldTokens(document, 'originalName')
        .filter(token => queryTokens.has(token)).length
      return { name: document.tool.qualifiedName, overlap }
    })
    .filter(candidate => candidate.overlap > 0)
    .sort((left, right) => right.overlap - left.overlap || left.name.localeCompare(right.name))
    .slice(0, limit)
    .map(candidate => candidate.name)
}
