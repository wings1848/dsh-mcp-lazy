/**
 * Cache hashing, validity, and atomic persistence.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  buildCacheEntry,
  computeConfigHash,
  CACHE_VERSION,
  isCacheEntryValid,
  loadMetadataCache,
  metadataCachePath,
  saveMetadataCache,
} from '../../lib/metadata-cache.js'
import type { ServerEntry, ToolMetadata } from '../../lib/types.js'

const originalHome = process.env['DSH_HOME']

before(() => {
  process.env['DSH_HOME'] = mkdtempSync(join(tmpdir(), 'dsh-mcp-lazy-cache-'))
})

after(() => {
  if (originalHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = originalHome
})

function stdioEntry(overrides: Partial<ServerEntry> = {}): ServerEntry {
  return {
    serverName: 'demo',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'demo-server'],
    env: { TOKEN: 'x' },
    cwd: '',
    ...overrides,
  }
}

function tool(originalName: string): ToolMetadata {
  return { originalName, qualifiedName: `demo__${originalName}`, description: `${originalName} tool` }
}

describe('computeConfigHash', () => {
  it('is stable across key order in env', () => {
    const left = computeConfigHash(stdioEntry({ env: { A: '1', B: '2' } }))
    const right = computeConfigHash(stdioEntry({ env: { B: '2', A: '1' } }))
    assert.equal(left, right)
  })

  it('changes when the transport-relevant config changes', () => {
    const base = computeConfigHash(stdioEntry())
    assert.notEqual(base, computeConfigHash(stdioEntry({ command: 'bunx' })))
    assert.notEqual(base, computeConfigHash(stdioEntry({ args: ['-y', 'other'] })))
    assert.notEqual(base, computeConfigHash(stdioEntry({ env: { TOKEN: 'y' } })))
    assert.notEqual(base, computeConfigHash(stdioEntry({ url: 'http://x' })))
  })

  it('ignores presentation and lifecycle fields', () => {
    const base = computeConfigHash(stdioEntry())
    assert.equal(
      base,
      computeConfigHash(
        stdioEntry({
          idleTimeout: 0,
          lifecycle: 'keep-alive',
          directTools: 'search',
          includeTools: ['a'],
          excludeTools: ['b'],
          searchKeywords: { a: ['k'] },
          disabled: true,
          toolCallTimeoutMs: 5,
        }),
      ),
    )
  })
})

describe('isCacheEntryValid', () => {
  const now = 1_000_000_000_000

  it('rejects a missing entry', () => {
    assert.equal(isCacheEntryValid(undefined, stdioEntry(), undefined, now), false)
  })

  it('accepts a matching, fresh entry', () => {
    const entry = stdioEntry()
    const cached = buildCacheEntry(entry, [tool('a')], undefined, now - 1000)
    assert.equal(isCacheEntryValid(cached, entry, undefined, now), true)
  })

  it('rejects an entry whose config changed', () => {
    const cached = buildCacheEntry(stdioEntry(), [tool('a')], undefined, now)
    assert.equal(isCacheEntryValid(cached, stdioEntry({ command: 'other' }), undefined, now), false)
  })

  it('rejects an entry past its age bound', () => {
    const entry = stdioEntry()
    const cached = buildCacheEntry(entry, [tool('a')], undefined, now - 5000)
    assert.equal(isCacheEntryValid(cached, entry, 1000, now), false)
  })

  it('rejects a non-finite timestamp', () => {
    const entry = stdioEntry()
    const cached = { ...buildCacheEntry(entry, [], undefined, now), cachedAt: Number.NaN }
    assert.equal(isCacheEntryValid(cached, entry, undefined, now), false)
  })
})

describe('persistence', () => {
  it('places the cache under $DSH_HOME/storages', () => {
    assert.ok(metadataCachePath().startsWith(process.env['DSH_HOME']!))
    assert.ok(metadataCachePath().endsWith(join('storages', 'mcp-lazy', 'cache.json')))
  })

  it('round-trips a cache through disk', () => {
    const entry = stdioEntry({ serverName: 'round-trip' })
    saveMetadataCache({
      version: CACHE_VERSION,
      servers: { 'round-trip': buildCacheEntry(entry, [tool('one')], 'usage text') },
    })
    const loaded = loadMetadataCache()
    assert.equal(loaded?.servers['round-trip']?.tools[0]?.originalName, 'one')
    assert.equal(loaded?.servers['round-trip']?.instructions, 'usage text')
  })

  it('ignores a cache written by another version', () => {
    writeFileSync(metadataCachePath(), JSON.stringify({ version: CACHE_VERSION + 1, servers: {} }))
    assert.equal(loadMetadataCache(), null)
  })

  it('ignores a corrupt cache instead of throwing', () => {
    writeFileSync(metadataCachePath(), '{ this is not json')
    assert.equal(loadMetadataCache(), null)
  })

  it('writes atomically and leaves no temp file behind', () => {
    const entry = stdioEntry({ serverName: 'atomic' })
    saveMetadataCache({ version: CACHE_VERSION, servers: { atomic: buildCacheEntry(entry, [], undefined) } })
    const raw = JSON.parse(readFileSync(metadataCachePath(), 'utf8')) as { version: number }
    assert.equal(raw.version, CACHE_VERSION)
  })
})
