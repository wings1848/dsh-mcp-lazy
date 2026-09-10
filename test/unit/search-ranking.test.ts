/**
 * Search ranking: camelCase tokenization, the coverage gate, and field weights.
 *
 * The camelCase case is a regression test. `getPixels` used to tokenize to the
 * single opaque token `getpixels`, so a search for `pixels` matched nothing —
 * and the failure was easy to miss, because a description that happens to
 * contain the word would match through the description field and hide it. These
 * tests therefore use neutral descriptions on purpose.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildToolDocument,
  FIELD_WEIGHTS,
  MAX_REGEX_QUERY_LENGTH,
  MIN_STEM_LENGTH,
  normalizeSearchText,
  paginate,
  rankSuggestions,
  rankToolMatches,
  regexToolMatches,
  scoreToolMatch,
  tokenize,
} from '../../lib/search-ranking.js'
import type { ToolDocument } from '../../lib/search-ranking.js'
import type { ServerEntry, ToolMetadata } from '../../lib/types.js'

/** A tool with no description, so only its name can be matched. */
function bare(
  serverName: string,
  originalName: string,
  description = '',
): ToolDocument {
  const tool: ToolMetadata = {
    originalName,
    qualifiedName: `${serverName}__${originalName}`,
    description,
  }
  return buildToolDocument(serverName, tool, {} satisfies Pick<ServerEntry, 'searchKeywords'>)
}

/** How many documents the query matches. */
function hits(documents: readonly ToolDocument[], query: string): number {
  return rankToolMatches(documents, query).length
}

describe('normalizeSearchText', () => {
  it('splits camelCase before lower-casing', () => {
    assert.equal(normalizeSearchText('getPixels'), 'get pixels')
    assert.equal(normalizeSearchText('createPullRequest'), 'create pull request')
  })

  it('leaves an already-separated name alone', () => {
    assert.equal(normalizeSearchText('get_pixels'), 'get pixels')
  })

  it('keeps non-Latin word characters instead of discarding them', () => {
    assert.deepEqual(tokenize('读取文件'), ['读取文件'])
  })
})

describe('camelCase tool names are searchable by sub-word', () => {
  it('finds getPixels from "pixels"', () => {
    assert.equal(hits([bare('devtools', 'getPixels')], 'pixels'), 1)
  })

  it('finds getPixels from the spaced spelling of its own sub-words', () => {
    assert.equal(hits([bare('devtools', 'getPixels')], 'get pixels'), 1)
  })

  it('finds getPixels from the exact name', () => {
    assert.equal(hits([bare('devtools', 'getPixels')], 'getPixels'), 1)
  })

  it('tokenizes the qualified name into its camelCase parts', () => {
    assert.deepEqual(bare('devtools', 'getPixels').nameTokens, ['devtools', 'get', 'pixels'])
  })
})

describe('coverage gate', () => {
  const documents = [bare('git', 'create_pull_request')]

  it('requires every token for a one- or two-token query', () => {
    assert.equal(hits(documents, 'create'), 1)
    assert.equal(hits(documents, 'create branch'), 0)
  })

  it('accepts a partially matching query of three or more tokens', () => {
    // create + request match, branch does not: 2/3 coverage.
    assert.equal(hits(documents, 'create request branch'), 1)
  })

  it('still rejects a query whose tokens barely match', () => {
    assert.equal(hits(documents, 'branch fork repo'), 0)
  })

  it('qualifies a whole-phrase hit however few tokens match', () => {
    const prose = [bare('srv', 'thing', 'fetches the widget catalogue')]
    assert.equal(hits(prose, 'widget catalogue'), 1)
  })
})

describe('field weights', () => {
  it('ranks a name hit above an identical description hit', () => {
    const inName = bare('srv', 'screenshot')
    const inProse = bare('srv', 'unrelated', 'take a screenshot of the page')
    const ranked = rankToolMatches([inProse, inName], 'screenshot')
    assert.equal(ranked.length, 2)
    assert.equal(ranked[0]?.tool.originalName, 'screenshot')
  })

  it('scores a whole-field exact match above a substring match', () => {
    const exact = bare('srv', 'echo')
    const partial = bare('srv', 'echo_loudly')
    assert.ok(
      (scoreToolMatch(exact, 'echo') ?? 0) > (scoreToolMatch(partial, 'echo') ?? 0),
    )
  })

  it('breaks ties on the qualified name so the order is stable', () => {
    const first = rankToolMatches([bare('srv', 'beta'), bare('srv', 'alpha')], 'srv')
    const second = rankToolMatches([bare('srv', 'beta'), bare('srv', 'alpha')], 'srv')
    assert.deepEqual(
      first.map(match => match.tool.qualifiedName),
      second.map(match => match.tool.qualifiedName),
    )
  })
})

describe('stem matching', () => {
  it('matches a longer query token against a shorter field token', () => {
    assert.equal(hits([bare('srv', 'take_screenshot')], 'screenshots'), 1)
  })

  it('ignores fragments shorter than the stem floor', () => {
    assert.ok(MIN_STEM_LENGTH > 3)
    assert.equal(hits([bare('srv', 'abc_thing')], 'abcde'), 0)
  })

  it('exposes the weights the scorer uses', () => {
    assert.ok(FIELD_WEIGHTS.qualifiedName > FIELD_WEIGHTS.description)
    assert.equal(FIELD_WEIGHTS.keywords, FIELD_WEIGHTS.description)
  })
})

describe('searchKeywords', () => {
  const tool: ToolMetadata = {
    originalName: 'list_pages',
    qualifiedName: 'browser__list_pages',
    description: 'Enumerate open tabs',
  }
  const withKeywords = buildToolDocument('browser', tool, {
    searchKeywords: { list_pages: ['tab', 'window'] },
  })

  it('lets a keyword find a tool whose own text lacks the word', () => {
    assert.equal(hits([withKeywords], 'window'), 1)
  })

  it('does not let a keyword outrank a real name match', () => {
    const named = bare('browser', 'window')
    const ranked = rankToolMatches([withKeywords, named], 'window')
    assert.equal(ranked[0]?.tool.originalName, 'window')
  })

  it('keeps keywords out of the searchable document text', () => {
    const description = withKeywords.fields.find(field => field.field === 'description')
    assert.equal(description?.value.includes('window'), false)
  })
})

describe('regex search', () => {
  it('reports an invalid pattern instead of throwing', () => {
    const outcome = regexToolMatches([bare('srv', 'echo')], '([')
    assert.ok('error' in outcome)
    assert.match(outcome.error, /Invalid regular expression/)
  })

  it('matches case-insensitively across name and description', () => {
    const documents = [bare('srv', 'getPixels', 'Reads the framebuffer')]
    const byName = regexToolMatches(documents, '^srv__get')
    assert.ok(!('error' in byName) && byName.matches.length === 1)
    const byProse = regexToolMatches(documents, 'FRAMEBUFFER')
    assert.ok(!('error' in byProse) && byProse.matches.length === 1)
  })

  it('rejects a pattern whose quantifiers nest', () => {
    // Regression: this shape used to run. Against a 28-character run it took
    // ~2 s, growing exponentially, and the search runs synchronously inside the
    // tool call — so it stalls the whole session rather than just being slow.
    for (const pattern of ['(a+)+c', '^(a+)+$', '(a*)*b', '(a{2,})+c', '((ab)+)+']) {
      const outcome = regexToolMatches([bare('srv', 'echo')], pattern)
      assert.ok('error' in outcome, `${pattern} should be rejected`)
      assert.match(outcome.error, /nests repeated quantifiers/)
    }
  })

  it('still accepts ordinary patterns that merely repeat a group', () => {
    for (const pattern of ['(?:ab)+c', 'a+b', 'screenshot', '(read|write)_\\w+']) {
      const outcome = regexToolMatches([bare('srv', 'echo')], pattern)
      assert.ok(!('error' in outcome), `${pattern} should be accepted`)
    }
  })

  it('rejects a pattern longer than the configured ceiling', () => {
    const outcome = regexToolMatches([bare('srv', 'echo')], 'a'.repeat(MAX_REGEX_QUERY_LENGTH + 1))
    assert.ok('error' in outcome)
    assert.match(outcome.error, /too long/)
  })

  it('does not backtrack on a hostile pattern', () => {
    // The rejection has to happen before the engine ever sees the pattern; if
    // the guard only warned, this call would take seconds.
    const hostile = bare('srv', 'thing', 'x' + 'a'.repeat(40) + 'y')
    const started = Date.now()
    const outcome = regexToolMatches([hostile], '(a+)+c')
    assert.ok('error' in outcome)
    assert.ok(Date.now() - started < 100, 'rejection must be immediate')
  })

  it('searches configured keywords as well as name and description', () => {
    const tool: ToolMetadata = {
      originalName: 'list_pages',
      qualifiedName: 'browser__list_pages',
      description: 'Enumerate open tabs',
    }
    const document = buildToolDocument('browser', tool, {
      searchKeywords: { list_pages: ['webkit'] },
    })
    const outcome = regexToolMatches([document], 'webkit')
    assert.ok(!('error' in outcome) && outcome.matches.length === 1)
  })
})

describe('paginate', () => {
  it('reports the next offset only while more remain', () => {
    assert.deepEqual(paginate(['a', 'b', 'c'], 0, 2), {
      items: ['a', 'b'],
      total: 3,
      hasMore: true,
      nextOffset: 2,
    })
    assert.deepEqual(paginate(['a', 'b', 'c'], 2, 2), {
      items: ['c'],
      total: 3,
      hasMore: false,
      nextOffset: null,
    })
  })
})

describe('rankSuggestions', () => {
  it('suggests a near miss for an unknown name', () => {
    const documents = [bare('git', 'create_pull_request'), bare('git', 'list_branches')]
    const suggestions = rankSuggestions(documents, 'create_pull_requests')
    assert.ok(suggestions.includes('git__create_pull_request'), suggestions.join(','))
  })

  it('falls back to token overlap when ranking finds nothing', () => {
    const documents = [bare('git', 'merge_branch')]
    const suggestions = rankSuggestions(documents, 'branch_merge')
    assert.deepEqual(suggestions, ['git__merge_branch'])
  })

  it('returns nothing when no name is close', () => {
    assert.deepEqual(rankSuggestions([bare('git', 'list_branches')], 'zzzzz'), [])
  })
})
