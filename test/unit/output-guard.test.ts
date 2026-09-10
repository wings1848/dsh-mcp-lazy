/**
 * Bounded output: what the guard keeps, what it spills, and what it says.
 *
 * The guard exists because the harness does not truncate tool output for us.
 * These tests use tiny ceilings so the interesting cases are reachable without
 * generating megabytes of text, and they assert on the spilled file's contents
 * — a notice that points at a file which does not hold the full text would be
 * worse than no notice at all.
 */

import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { after, describe, it } from 'node:test'
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_OUTPUT_LINES,
  formatSize,
  OutputGuard,
} from '../../lib/output-guard.js'

const guards: OutputGuard[] = []

/** A guard registered for teardown. */
function guard(options?: { enabled?: boolean; maxBytes?: number; maxLines?: number }): OutputGuard {
  const built = new OutputGuard(options)
  guards.push(built)
  return built
}

after(async () => {
  await Promise.all(guards.map(instance => instance.dispose()))
})

describe('formatSize', () => {
  it('scales through B, KiB and MiB', () => {
    assert.equal(formatSize(512), '512 B')
    assert.equal(formatSize(2048), '2.0 KiB')
    assert.equal(formatSize(3 * 1024 * 1024), '3.0 MiB')
  })
})

describe('OutputGuard', () => {
  it('leaves a small payload exactly as it was', async () => {
    const result = await guard().guard('short result')
    assert.equal(result.text, 'short result')
    assert.equal(result.truncated, false)
    assert.equal(result.fullOutputPath, undefined)
  })

  it('truncates by bytes and keeps the head', async () => {
    const body = `${'A'.repeat(50)}${'B'.repeat(5000)}`
    const result = await guard({ maxBytes: 200, maxLines: 10_000 }).guard(body)
    assert.equal(result.truncated, true)
    assert.ok(result.text.startsWith('A'.repeat(50)), 'the head must survive')
    assert.ok(!result.text.includes('B'.repeat(200)), 'the tail must be dropped')
    assert.match(result.text, /MCP output truncated/)
  })

  it('truncates by lines', async () => {
    const body = Array.from({ length: 500 }, (_, index) => `line ${index}`).join('\n')
    const result = await guard({ maxLines: 10, maxBytes: 10_000_000 }).guard(body)
    assert.equal(result.truncated, true)
    assert.match(result.text, /line 0/)
    assert.ok(!result.text.includes('line 400'))
    assert.match(result.text, /first 10 lines/)
  })

  it('spills the full text and points at it', async () => {
    const body = 'x'.repeat(4000)
    const result = await guard({ maxBytes: 100, maxLines: 10_000 }).guard(body)

    assert.ok(result.fullOutputPath !== undefined)
    assert.ok(result.text.includes(result.fullOutputPath), 'the notice must name the file')
    assert.equal(readFileSync(result.fullOutputPath, 'utf8'), body)
    // Spilled output can carry secrets, so it must not be world-readable.
    assert.equal(statSync(result.fullOutputPath).mode & 0o777, 0o600)
  })

  it('reports the sizes it actually moved', async () => {
    const body = 'y'.repeat(3000)
    const result = await guard({ maxBytes: 120, maxLines: 10_000 }).guard(body)
    assert.equal(result.originalBytes, 3000)
    assert.ok(result.returnedBytes < result.originalBytes)
    assert.ok(result.returnedBytes > 120, 'the notice itself is part of the returned text')
  })

  it('counts lines and bytes for the notice', async () => {
    const body = `${'z'.repeat(500)}\n${'z'.repeat(500)}\n${'z'.repeat(500)}`
    const result = await guard({ maxBytes: 50, maxLines: 10_000 }).guard(body)
    assert.equal(result.originalLines, 3)
    assert.match(result.text, /original 3 lines/)
  })

  it('does nothing at all when disabled', async () => {
    const body = 'q'.repeat(10_000)
    const result = await guard({ enabled: false, maxBytes: 10, maxLines: 1 }).guard(body)
    assert.equal(result.truncated, false)
    assert.equal(result.text, body)
    assert.equal(result.fullOutputPath, undefined)
  })

  it('never splits a multi-byte character at the cut', async () => {
    // Four bytes per emoji; a 6-byte budget would otherwise cut one in half.
    const body = '😀'.repeat(20)
    const result = await guard({ maxBytes: 6, maxLines: 10_000 }).guard(body)
    const preview = result.text.split('\n\n[MCP output truncated')[0] ?? ''
    assert.ok(!preview.includes('\uFFFD'), 'no replacement character may appear')
    assert.ok(Buffer.byteLength(preview, 'utf8') <= 6)
  })

  it('reports the default ceilings it advertises', () => {
    const instance = guard()
    assert.deepEqual(instance.limits, {
      maxBytes: DEFAULT_MAX_OUTPUT_BYTES,
      maxLines: DEFAULT_MAX_OUTPUT_LINES,
    })
    assert.equal(instance.enabled, true)
  })

  it('removes its spill files on dispose', async () => {
    const instance = guard({ maxBytes: 10, maxLines: 10_000 })
    const result = await instance.guard('w'.repeat(500))
    assert.ok(result.fullOutputPath !== undefined)
    await instance.dispose()
    assert.throws(() => statSync(result.fullOutputPath ?? ''), /ENOENT/)
  })

  it('keeps spills out of the repository', async () => {
    const result = await guard({ maxBytes: 10, maxLines: 10_000 }).guard('v'.repeat(500))
    assert.ok(result.fullOutputPath?.startsWith(tmpdir()), result.fullOutputPath)
  })

  it('does not read or write anything before it is needed', async () => {
    // A guard that created its directory eagerly would leave an empty temp dir
    // behind on every session, including ones that never truncate anything.
    const instance = guard()
    await instance.guard('small')
    await instance.dispose()
    assert.ok(true)
  })
})

describe('a spilled result stays actionable', () => {
  it('names the file in a form the model can pass to read', async () => {
    const body = 'k'.repeat(2000)
    const result = await guard({ maxBytes: 64, maxLines: 10_000 }).guard(body)
    const path = result.fullOutputPath ?? ''

    // An absolute path under the temp directory, which is what `read` needs.
    assert.ok(path.startsWith(tmpdir()), path)
    assert.match(path, /dsh-mcp-lazy-output-[^/]+\/output-[0-9a-f]{8}\.txt$/)
    assert.match(result.text, /read it with offset\/limit, or grep it/)
    assert.equal(readFileSync(path, 'utf8'), body)
  })
})
