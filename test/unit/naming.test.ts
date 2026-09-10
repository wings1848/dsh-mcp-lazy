/**
 * Deterministic naming and filter matching.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isToolAllowed,
  matchesNamePattern,
  MAX_FUNCTION_NAME_LENGTH,
  qualifiedToolName,
  resolveSearchKeywords,
} from '../../lib/naming.js'
import type { ToolMetadata } from '../../lib/types.js'

function tool(originalName: string, qualified?: string): ToolMetadata {
  return {
    originalName,
    qualifiedName: qualified ?? `srv__${originalName}`,
    description: '',
  }
}

describe('qualifiedToolName', () => {
  it('is the clean concatenation when the identity already satisfies the contract', () => {
    assert.equal(qualifiedToolName('github', 'create_issue'), 'github__create_issue')
  })

  it('is a pure function of the identity', () => {
    assert.equal(qualifiedToolName('a-b_c', 'x1'), qualifiedToolName('a-b_c', 'x1'))
  })

  it('replaces characters outside the function-name contract', () => {
    const name = qualifiedToolName('srv', 'get.thing/v2')
    assert.match(name, /^[A-Za-z0-9_-]+$/)
    assert.ok(name.includes('_'))
  })

  it('never exceeds the contract length', () => {
    const name = qualifiedToolName('s', 'x'.repeat(200))
    assert.ok(name.length <= MAX_FUNCTION_NAME_LENGTH, `${name.length} > ${MAX_FUNCTION_NAME_LENGTH}`)
  })

  it('keeps two long identities distinct instead of collapsing them', () => {
    const a = qualifiedToolName('srv', `${'x'.repeat(100)}a`)
    const b = qualifiedToolName('srv', `${'x'.repeat(100)}b`)
    assert.notEqual(a, b)
  })

  it('distinguishes the same tool name on two servers', () => {
    assert.notEqual(qualifiedToolName('one', 'search'), qualifiedToolName('two', 'search'))
  })
})

describe('matchesNamePattern', () => {
  it('matches exactly and case-insensitively', () => {
    assert.equal(matchesNamePattern('read_file', 'read_file'), true)
    assert.equal(matchesNamePattern('Read_File', 'read_file'), true)
  })

  it('matches globs', () => {
    assert.equal(matchesNamePattern('get_*', 'get_screenshot'), true)
    assert.equal(matchesNamePattern('*_issue', 'create_issue'), true)
    assert.equal(matchesNamePattern('get_*', 'list_sims'), false)
  })

  it('treats regex metacharacters in a pattern as literal', () => {
    assert.equal(matchesNamePattern('a.b', 'axb'), false)
    assert.equal(matchesNamePattern('a.b', 'a.b'), true)
  })
})

describe('isToolAllowed', () => {
  it('keeps everything when no filter is configured', () => {
    assert.equal(isToolAllowed(tool('anything'), {}), true)
  })

  it('keeps only include matches and matches either name spelling', () => {
    const entry = { includeTools: ['read_*'] }
    assert.equal(isToolAllowed(tool('read_file'), entry), true)
    assert.equal(isToolAllowed(tool('write_file'), entry), false)
    assert.equal(isToolAllowed(tool('other', 'srv__read_dir'), entry), true)
  })

  it('lets exclude win over include', () => {
    const entry = { includeTools: ['get_*'], excludeTools: ['get_secret'] }
    assert.equal(isToolAllowed(tool('get_public'), entry), true)
    assert.equal(isToolAllowed(tool('get_secret'), entry), false)
  })
})

describe('resolveSearchKeywords', () => {
  it('unions every matching key and deduplicates', () => {
    const keywords = resolveSearchKeywords(tool('take_screenshot'), {
      take_screenshot: ['image', 'capture'],
      'take_*': ['capture', 'png'],
      unrelated: ['nope'],
    })
    assert.deepEqual(keywords, ['image', 'capture', 'png'])
  })

  it('returns nothing without a keyword map', () => {
    assert.deepEqual(resolveSearchKeywords(tool('x'), undefined), [])
  })
})
