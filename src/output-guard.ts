/**
 * Bounded, spill-to-disk output for server-authored text.
 *
 * The gateway's token saving is a few hundred tokens of tool definitions per
 * request. A single unbounded tool result can cost tens of thousands, so the
 * saving is only real if results are bounded too — and nothing upstream does it:
 * the harness has no framework-level truncation of tool output, and the tools
 * that do spill (bash, fs-search, pwsh) implement it themselves.
 *
 * The policy is pi-mcp-adapter's: keep the **head** of the output, write the
 * whole thing to a temp file, and tell the model where it went. Keeping the head
 * rather than the tail is deliberate — an MCP result usually leads with its
 * summary, and the model can reach the rest with `read`/`grep`.
 *
 * @module dsh-mcp-lazy/output-guard
 */

import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OutputGuardConfig } from './types.js'

/** Inline byte ceiling before the text is truncated and spilled. */
export const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024

/** Inline line ceiling before the text is truncated and spilled. */
export const DEFAULT_MAX_OUTPUT_LINES = 2000

/**
 * Ceiling on what is written to the spill file.
 *
 * The point of the spill is to make the full output *reachable*, not to
 * guarantee it fits on disk; a runaway server should not be able to fill the
 * volume. Past this the file holds the head and says so.
 */
export const MAX_SPILL_BYTES = 16 * 1024 * 1024

/** What the guard did to one payload. */
export interface GuardedOutput {
  /** The text to hand to the model, notice included when truncated. */
  text: string
  truncated: boolean
  originalBytes: number
  returnedBytes: number
  originalLines: number
  returnedLines: number
  /** Where the full text was written, when a spill happened. */
  fullOutputPath?: string
  /** Why the spill failed, when it did. */
  writeError?: string
}

/**
 * Render a byte count for a human.
 *
 * @param bytes - Size in bytes.
 * @returns A short human-readable size.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/**
 * Cut a string to a byte budget without splitting a UTF-8 sequence.
 *
 * @param text - The text to cut.
 * @param maxBytes - Maximum bytes to keep.
 * @returns The head plus whether anything was dropped.
 */
function cutAtBytes(text: string, maxBytes: number): { text: string; cut: boolean } {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return { text, cut: false }
  let end = maxBytes
  // Walk back off a continuation byte so the last character stays whole.
  while (end > 0 && end < buffer.length && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return { text: buffer.subarray(0, end).toString('utf8'), cut: true }
}

/**
 * Bound server-authored text before it reaches the model.
 *
 * One instance per plugin activation. It keeps the temp directories it creates
 * so {@link OutputGuard.dispose} can clean them up; files left behind by a crash
 * are the operating system's to reap, which is why they live under `tmpdir()`.
 */
export class OutputGuard {
  readonly #enabled: boolean
  readonly #maxBytes: number
  readonly #maxLines: number
  readonly #directories = new Set<string>()

  /**
   * @param config - Guard configuration; omitted means "enabled with defaults".
   */
  constructor(config?: OutputGuardConfig) {
    this.#enabled = config?.enabled !== false
    this.#maxBytes = config?.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.#maxLines = config?.maxLines ?? DEFAULT_MAX_OUTPUT_LINES
  }

  /** Whether truncation is active at all. */
  get enabled(): boolean {
    return this.#enabled
  }

  /** The inline ceilings, for status output. */
  get limits(): { maxBytes: number; maxLines: number } {
    return { maxBytes: this.#maxBytes, maxLines: this.#maxLines }
  }

  /**
   * Truncate one payload if it exceeds the ceilings, spilling the full text.
   *
   * @param text - The text about to be returned as a tool result.
   * @returns The text to return, plus what was done to it.
   */
  async guard(text: string): Promise<GuardedOutput> {
    const originalBytes = Buffer.byteLength(text, 'utf8')
    const lines = text.split('\n')
    const originalLines = lines.length

    const unchanged: GuardedOutput = {
      text,
      truncated: false,
      originalBytes,
      returnedBytes: originalBytes,
      originalLines,
      returnedLines: originalLines,
    }
    if (!this.#enabled) return unchanged
    if (originalBytes <= this.#maxBytes && originalLines <= this.#maxLines) return unchanged

    // Lines first, then bytes: cutting bytes first could leave a partial line
    // that the line accounting would then misreport.
    const overLines = originalLines > this.#maxLines
    const lineCut = overLines ? lines.slice(0, this.#maxLines).join('\n') : text
    const byteCut = cutAtBytes(lineCut, this.#maxBytes)

    const reason = overLines
      ? `showing the first ${this.#maxLines} lines`
      : `showing the first ${formatSize(this.#maxBytes)}`

    const spill = await this.#spill(text)
    const notice = spill.path === undefined
      ? `[MCP output truncated: original ${originalLines} lines / ${formatSize(originalBytes)}. ` +
        `${reason}. The full text could not be saved: ${spill.error ?? 'unknown error'}.]`
      : `[MCP output truncated: original ${originalLines} lines / ${formatSize(originalBytes)}. ` +
        `${reason}. Full text saved to: ${spill.path} — read it with offset/limit, or grep it.]`

    const preview = byteCut.text
    const returned = `${preview}\n\n${notice}`
    return {
      text: returned,
      truncated: true,
      originalBytes,
      returnedBytes: Buffer.byteLength(returned, 'utf8'),
      originalLines,
      returnedLines: preview.split('\n').length + notice.split('\n').length + 1,
      ...(spill.path !== undefined ? { fullOutputPath: spill.path } : {}),
      ...(spill.error !== undefined ? { writeError: spill.error } : {}),
    }
  }

  /**
   * Write the full text under a throwaway temp directory.
   *
   * @param text - The complete payload.
   * @returns The file path, or the reason it could not be written.
   */
  async #spill(text: string): Promise<{ path?: string; error?: string }> {
    try {
      const directory = await mkdtemp(join(tmpdir(), 'dsh-mcp-lazy-output-'))
      this.#directories.add(directory)
      const path = join(directory, `output-${randomBytes(4).toString('hex')}.txt`)
      const trimmed = cutAtBytes(text, MAX_SPILL_BYTES)
      const body = trimmed.cut
        ? `${trimmed.text}\n\n[spill truncated at ${formatSize(MAX_SPILL_BYTES)}]`
        : text
      await writeFile(path, body, { encoding: 'utf8', mode: 0o600 })
      return { path }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Remove every temp directory this guard created.
   *
   * Best-effort by design: a spill file that outlives the session is a minor
   * disk leak, while a teardown that throws would fail the plugin unload.
   */
  async dispose(): Promise<void> {
    const directories = [...this.#directories]
    this.#directories.clear()
    await Promise.all(
      directories.map(directory =>
        rm(directory, { recursive: true, force: true }).catch(() => undefined),
      ),
    )
  }
}
