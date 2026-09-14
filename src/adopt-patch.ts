/**
 * Character-level surgery on a patch file.
 *
 * Everything here exists for one reason: the write path must not re-serialise
 * the file. A patch layer carries hand-written comments, deliberate blank lines,
 * block scalars and `!!js` expressions, and a parse-then-dump round trip loses
 * all four — `dsh-config-manager` rewrites the file that way, which is why the
 * guidance is not to keep anything in it that you mind losing. This command
 * edits a character range and leaves every other byte alone.
 *
 * @module dsh-mcp-lazy/adopt-patch
 */

import yaml from 'js-yaml'
import { ENTRY_SCHEMA } from './adopt-compose.js'

/** A line of a text file, with its offsets, so slices need no arithmetic. */
export interface SourceLine {
  /** Zero-based index of the line. */
  number: number
  /** Byte offset of the first character of the line. */
  start: number
  /** The line's text, without its terminator. */
  text: string
  /** Leading whitespace, tabs expanded to their own run of spaces. */
  indent: number
}

/**
 * Split text into lines with offsets.
 *
 * Line endings are kept out of the text and reproduced by the caller, so a file
 * with CRLF endings is not silently normalised by an edit that only meant to
 * touch one line.
 *
 * @param text - The file's contents.
 * @returns One record per line, plus a trailing empty line when the file ends
 * with a newline (so an append lands on its own line).
 */
export function splitSource(text: string): SourceLine[] {
  const lines: SourceLine[] = []
  let offset = 0
  const raw = text.split('\n')
  for (let index = 0; index < raw.length; index += 1) {
    const withCr = raw[index] ?? ''
    const body = withCr.endsWith('\r') ? withCr.slice(0, -1) : withCr
    lines.push({
      number: index,
      start: offset,
      text: body,
      indent: /^[ \t]*/.exec(body)?.[0].length ?? 0,
    })
    offset += withCr.length + 1
  }
  return lines
}

/** A half-open range of characters in a file. */
export interface Span {
  start: number
  end: number
}

/** One row of a patch file that mounts `@deepseek-ai/dsh-mcp-client`. */
export interface NativeRow {
  /** The row's loader id. */
  id: string
  /** The `config.serverName` it declares, when it declares one. */
  serverName?: string
  /** The row's original YAML text, verbatim. */
  raw: string
  /**
   * The server-facing view of the row: its `config` fields, plus the row's own
   * `id` and `disabled`. See {@link serverFieldsOf}.
   */
  fields: Record<string, unknown>
  /** Which layer the file belongs to. */
  layer: 'home' | 'profile'
  /** The absolute path of the file the row is written in. */
  file: string
  /** The character range the row occupies, excluding its leading indentation. */
  span: Span
  /** The indentation of the row's own keys, in characters. */
  keyIndent: number
  /** The package the row mounts, when it says so itself. */
  name?: string
  /** Whether the row is already disabled in the file. */
  disabled: boolean
  /** Whether the row's text contains a `!!js` expression. */
  jsExpression: boolean
  /**
   * Set when the row could not be tied to a file, so there is nothing to edit.
   *
   * Its `file` then names where the dump said the row came from rather than a
   * path that can be rewritten, which is why the planner refuses it outright.
   */
  origin?: string
}

/** Thrown when a file cannot be read as the dialect the loader reads. */
export class PatchFormatError extends Error {
  /** The file the problem is in. */
  readonly file: string

  /** What is wrong with it. */
  readonly detail: string

  /**
   * @param file - The file the problem is in.
   * @param detail - What is wrong with it.
   */
  constructor(file: string, detail: string) {
    super(`${file}: ${detail}`)
    this.name = 'PatchFormatError'
    this.file = file
    this.detail = detail
  }
}

/**
 * Find the character range of one row inside an `insert` list.
 *
 * The scan is line-based and indentation-aware rather than node-based, because
 * js-yaml does not record node positions. The shape being matched is narrow and
 * fixed — a mapping item of a sequence, possibly nested under `- insert:` — so
 * the rules are:
 *
 * - the row's text starts at an item header whose own `id:` is the wanted one,
 *   which may be an item of a sequence nested under `insert:` (the usual shape)
 *   or a top-level id-targeted patch;
 * - the item is re-parsed from its **outermost** header, so the text handed to
 *   YAML is a complete document fragment and not a fragment of one;
 * - it ends at the next line with the same or lower indentation than its own
 *   header.
 *
 * A row whose text cannot be delimited this way raises rather than being guessed
 * at: a wrong guess here writes the user's config file incorrectly.
 *
 * @param text - The file's contents.
 * @param id - The loader id of the row to find.
 * @param file - The file's path, for errors.
 * @param layer - Which layer the file belongs to.
 * @returns The row, or undefined when the file has no such row.
 * @throws {PatchFormatError} When the row exists but cannot be delimited safely.
 */
export function findNativeRow(
  text: string,
  id: string,
  file: string,
  layer: 'home' | 'profile',
): NativeRow | undefined {
  const lines = splitSource(text)
  for (let index = 0; index < lines.length; index += 1) {
    const header = itemHeader(lines[index]!)
    if (header === undefined || header.id !== id) continue

    // The row is one sequence item. When the matched header is `- insert:`'s
    // list, the content is scanned to find which of that list's items declares
    // the id being looked up, so a block holding two rows yields two ranges
    // instead of one range covering both.
    const target = targetItem(lines, index, id)
    if (target === undefined) continue
    const end = findRowEnd(lines, target, lines[target]!.indent)
    const raw = text.slice(lines[target]!.start + lines[target]!.indent, end)
    let fields: Record<string, unknown>
    try {
      fields = serverFieldsOf(parseRow(reindentForParsing(raw, lines[target]!.indent), file))
    } catch {
      // A row this command cannot parse is not a row it can act on. Throwing
      // here would make the caller's "is this one of ours?" question fatal,
      // which is the wrong shape for a question asked about every id in a file.
      return undefined
    }
    if (fields['id'] !== id) {
      throw new PatchFormatError(
        file,
        `the item starting at line ${target + 1} declares id "${String(fields['id'])}" but was matched as "${id}"`,
      )
    }
    return {
      id,
      ...(typeof fields['serverName'] === 'string' ? { serverName: fields['serverName'] } : {}),
      ...(typeof fields['name'] === 'string' ? { name: fields['name'] } : {}),
      raw,
      fields,
      layer,
      file,
      span: { start: lines[target]!.start + lines[target]!.indent, end },
      keyIndent: header.keyIndent,
      disabled: fields['disabled'] === true,
      jsExpression: /!!js(?:\s|$)/.test(raw),
    }
  }
  return undefined
}

/**
 * The sequence item that declares this id, starting from a matched header.
 *
 * A header line either *is* a row (`- id: x` with its own keys) or carries a
 * list of them (`- insert:` and then `- id: x` items on deeper lines). The keys
 * of a row sit two columns past its dash, so an item's own content is the run of
 * lines strictly deeper than its dash — wrapping one level does not change that,
 * which is why the same scan works for both shapes.
 *
 * @param lines - The file's lines.
 * @param index - Index of the matched header line.
 * @param id - The loader id being looked up.
 * @returns The index of the item that declares it, or undefined.
 */
function targetItem(
  lines: readonly SourceLine[],
  index: number,
  id: string,
): number | undefined {
  const end = findItemEnd(lines, index)
  const header = itemHeader(lines[index]!)
  /* v8 ignore next -- callers only pass a line they already read a header from */
  if (header === undefined) return undefined
  if (header.id === id) return index

  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]!
    if (line.start >= end) break
    const candidate = itemHeader(line)
    if (candidate === undefined || candidate.id !== id) continue
    // Only items of the list this header introduces, never a nested one that
    // happens to carry the same id.
    const owning = itemHeader(lines[index]!)
    /* v8 ignore next -- the header was read two statements up */
    if (owning === undefined) continue
    if (line.indent <= owning.keyIndent) break
    return cursor
  }
  return undefined
}

/**
 * Re-indent an item's text so it parses as a standalone YAML document.
 *
 * A row's slice starts at its dash but *keeps* the indentation of every line
 * after the first, because those bytes are what a rewrite has to preserve. YAML
 * does not read it that way: at column zero, a `- id: x` item has no room for a
 * `      name:` on the next line.
 *
 * The whole item is therefore shifted left, first line included, by the item's
 * own column. Shifting only the continuation lines is what flattens a row: the
 * difference between a continuation line's column and the item's is *relative*,
 * and for a simple row it is smaller than the column of a key inside a nested
 * mapping. Moving the whole block keeps every relative gap, which is the only
 * thing the structure depends on.
 *
 * @param text - The item's original text, first line at column zero.
 * @param indent - The item's own column in the file.
 * @returns The same item as a top-level document.
 */
function reindentForParsing(text: string, indent: number): string {
  if (indent === 0) return text
  const strip = ' '.repeat(indent)
  return text
    .split('\n')
    .map(line => (line.startsWith(strip) ? line.slice(indent) : line))
    .join('\n')
}

/**
 * The index an item ends at, found by indentation alone.
 *
 * @param lines - The file's lines.
 * @param index - Index of the item's header line.
 * @returns One past the last byte of the item.
 */
function findItemEnd(lines: readonly SourceLine[], index: number): number {
  const itemIndent = lines[index]!.indent
  let last = index
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]!
    if (line.text.trim() === '') continue
    if (line.indent <= itemIndent) break
    last = cursor
  }
  return lines[last]!.start + lines[last]!.text.length
}

/** An item header: `- id: x`, or `- name: x` for a row with no id. */
interface ItemHeader {
  /** The declared loader id, when the header declares one. */
  id?: string
  /** Indentation of the keys that follow the dash. */
  keyIndent: number
}

/**
 * Read a line as the first line of a sequence item.
 *
 * @param line - The line to read.
 * @returns The header, or undefined when the line does not start an item.
 */
function itemHeader(line: SourceLine): ItemHeader | undefined {
  // A header's first line is a mapping entry, so it always has a key. That is
  // what separates one from a scalar item further down a row's config — an
  // `args:` list is full of lines like `- serve`, and treating one of those as a
  // header is how a lookup ends up looking inside the wrong item.
  const match = /^(\s*)-\s+([^\s:#][^:]*):(?:\s|$)/.exec(line.text)
  if (match === null) return undefined
  const itemIndent = match[1]?.length ?? 0
  const key = match[2] ?? ''
  // `match[0]` ends at the colon (plus at most one space); the rest of the line
  // is the scalar value. `- insert:` has none, and is still a header.
  const value = unquote(line.text.slice(match[0].length))
  // `- id: x` names a row; `- insert:` and `- group:` carry one.
  return {
    ...(key === 'id' && value !== '' ? { id: value } : {}),
    keyIndent: itemIndent + 2,
  }
}

/**
 * Find where a sequence item ends.
 *
 * @param lines - The file's lines.
 * @param start - Index of the item's first line.
 * @param itemIndent - The indentation of that item's `-`.
 * @returns The index just past the item's last line.
 */
function findRowEnd(lines: readonly SourceLine[], start: number, itemIndent: number): number {
  let last = start
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.text.trim() === '') continue
    if (line.indent <= itemIndent) break
    // A block scalar's body may contain anything, including something that looks
    // like a new item. Its own indentation is deeper, so it is still inside the
    // row -- and `raw` keeps it, which is what matters.
    last = index
  }
  return lines[last]!.start + lines[last]!.text.length
}

/**
 * Parse one row's YAML text into the mapping that describes the server.
 *
 * A row has two spellings in the wild, and both mean the same thing:
 *
 * ```yaml
 * - id: mcp-codegraph-managed          # an insert: the id lives on the item,
 *   name: '@deepseek-ai/dsh-mcp-client'  # the server fields under config
 *   config: { serverName: codegraph, … }
 * - insert:
 *     - id: x
 *       name: '@deepseek-ai/dsh-mcp-client'
 *       config: { … }
 * ```
 *
 * The returned mapping is the server-facing view — the row's own `id`, `name`
 * and `disabled` alongside the server's fields — because everything downstream
 * asks "which server is this and can it be loaded", never "how was the row
 * written".
 *
 * @param raw - The row's text, starting at its outermost item header.
 * @param file - The file it came from, for the error message.
 * @returns The row's mapping, without the `insert:` wrapper.
 * @throws {PatchFormatError} When the text is not a single-entry operation list.
 */
export function parseRow(raw: string, file: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = yaml.load(raw, { schema: ENTRY_SCHEMA })
  } catch (error) {
    throw new PatchFormatError(file, `cannot parse the row as YAML: ${String(error)}`)
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new PatchFormatError(file, 'the row is not a single-entry operation list')
  }
  const entry = parsed[0] as { insert?: unknown; config?: unknown } & Record<string, unknown>
  if (Array.isArray(entry?.insert)) {
    const inner = (entry.insert as unknown[])[0]
    if (typeof inner !== 'object' || inner === null) {
      throw new PatchFormatError(file, 'the insert list does not start with a mapping')
    }
    return inner as Record<string, unknown>
  }
  // Two more shapes a single item can legitimately have, and both mean "this
  // item configures a server":
  //
  //   - id: x                 # a bare insert: the item itself is the row
  //     name: '@…/dsh-mcp-client'
  //     config: { … }
  //   - id: x                 # an id-targeted *patch*: the server fields sit
  //     config: { … }         # directly under config, and there is no name
  //
  // The second is what a hand-written `- id: mcp-lazy` row looks like, and also
  // what a patch-only layer contributes to a row declared elsewhere. Recognising
  // it is what lets a row be found in *every* file that declares it.
  if (typeof entry === 'object' && entry !== null && typeof entry['config'] === 'object') {
    return entry as Record<string, unknown>
  }
  throw new PatchFormatError(file, 'the row is neither an insert nor an id-targeted patch')
}

/**
 * Flatten a row's mapping into the server's own fields.
 *
 * The row's `config` is where the server fields live; `id`, `name` and
 * `disabled` sit beside it and describe the loader row. Adopting a row means
 * taking the first and leaving the second, so the two are separated here rather
 * than at every call site.
 *
 * @param fields - A row's mapping, as {@link parseRow} returns it.
 * @returns The server's fields, plus the row's `id` and `disabled`.
 */
export function serverFieldsOf(fields: Record<string, unknown>): Record<string, unknown> {
  const config = fields['config']
  const server = typeof config === 'object' && config !== null && !Array.isArray(config)
    ? { ...(config as Record<string, unknown>) }
    : {}
  // `name` is the package the row *mounts*, and callers need it to tell which
  // plugin's rows they are looking at. It is a row field rather than a server
  // field, so it is named explicitly here and filtered out again by
  // `serverEntryFrom`.
  if (typeof fields['name'] === 'string') server['name'] = fields['name']
  if (typeof fields['id'] === 'string') server['id'] = fields['id']
  if (fields['disabled'] !== undefined) server['disabled'] = fields['disabled']
  return server
}

/**
 * Locate the `servers` sequence of a plugin row, so an entry can be appended.
 *
 * Appending a second `- id: mcp-lazy` row instead would *replace* the whole
 * config rather than merge into it: a patch's `config` is a straight assignment,
 * so the existing `idleTimeout`, `outputGuard` and every other server would
 * disappear. That is the single most destructive mistake this command could
 * make, which is why the list is found by hand and the caller refuses to write
 * when it cannot be.
 *
 * The line ending is reported rather than assumed: a file written on Windows is
 * not this command's business to normalise, and an edit that changed every line
 * ending would show up as a whole-file diff for a one-line change.
 *
 * @param text - The file's contents.
 * @param id - The loader id of the row to modify.
 * @param file - The file's path, for errors.
 * @returns The sequence's span, its item indentation, whether it is empty, the
 * offset a new item can be appended at, and the file's line ending. When `empty`
 * is true the span covers **only the key**, either with its empty flow sequence
 * (`servers: []`) or alone (`servers:` on its own line) — i.e. `servers:` plus
 * whatever follows it on that line — because that is the text a caller replaces.
 * @throws {PatchFormatError} When the row has no usable `servers` list.
 */
export function findServersList(
  text: string,
  id: string,
  file: string,
): {
  span: Span
  itemIndent: number
  empty: boolean
  appendAt: number
  lineEnding: string
} {
  const lineEnding = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = splitSource(text)
  for (let index = 0; index < lines.length; index += 1) {
    const header = itemHeader(lines[index]!)
    if (header === undefined || header.id !== id) continue
    const rowEnd = findRowEnd(lines, index, lines[index]!.indent)
    const rowIndent = lines[index]!.indent

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor]!
      if (candidate.start >= rowEnd) break
      const key = /^(\s*)servers:\s*(.*)$/.exec(candidate.text)
      if (key === null || candidate.indent <= rowIndent) continue
      const keyIndent = key[1]?.length ?? 0
      const inline = (key[2] ?? '').trim()

      // A comment is not part of the value: `servers:   # add servers below` is a
      // block list with a note beside it, and refusing it would reject a whole
      // file over a punctuation choice. A value that *starts* with `#` is only a
      // comment — YAML would read it as one, and after trimming there is no
      // whitespace left to match on.
      const value =
        inline.startsWith('#') ? '' : inline.replace(/\s+#.*$/, '').trim()

      if (value.startsWith('[') && value.endsWith(']')) {
        // Flow style. An empty list is the one case worth handling: there is
        // nothing to preserve, and replacing `[]` with a block list is exactly
        // the edit a hand-written file would get.
        if (value === '[]') {
          return {
            span: { start: candidate.start + keyIndent, end: candidate.start + candidate.text.length },
            itemIndent: keyIndent + 2,
            empty: true,
            appendAt: candidate.start + candidate.text.length,
            lineEnding,
          }
        }
        throw new PatchFormatError(
          file,
          `the servers list of "${id}" is in flow style and not empty; add servers by hand or convert it to a block list first`,
        )
      }
      if (value !== '') {
        throw new PatchFormatError(
          file,
          `the servers key of "${id}" has an unexpected value "${value}"`,
        )
      }

      // Block style: the sequence items are the lines indented deeper than the
      // key that follow it.
      //
      // Only items at the sequence's *own* indentation count. A server entry
      // contains nested sequences of its own (`args:` is the common one), and an
      // `args` entry must not be mistaken for a server.
      //
      // This filter is defensive rather than load-bearing: the end of the list
      // is computed by {@link findRowEnd} from the item it found, so a nested
      // item would still resolve to the same insertion point. It is kept because
      // the *identity* of `lastItem` is what a future reader will reason about,
      // and "the last server" is the correct answer to give them.
      const sequenceIndent = firstItemIndent(lines, cursor, rowEnd, keyIndent)
      let firstItem: number | undefined
      let lastItem: number | undefined
      for (let scan = cursor + 1; scan < lines.length; scan += 1) {
        const body = lines[scan]!
        if (body.start >= rowEnd) break
        if (body.text.trim() === '') continue
        if (body.indent <= keyIndent) break
        if (body.indent === sequenceIndent && /^\s*-\s/.test(body.text)) {
          firstItem ??= scan
          lastItem = scan
        }
      }
      if (firstItem === undefined || lastItem === undefined) {
        return {
          span: { start: candidate.start + keyIndent, end: candidate.start + candidate.text.length },
          itemIndent: keyIndent + 2,
          empty: true,
          appendAt: candidate.start + candidate.text.length,
          lineEnding,
        }
      }
      // The end of the *item*, not of its first line: a server entry runs for
      // as many lines as it has fields, and inserting after the first one puts
      // the new server inside the old one.
      const end = findRowEnd(lines, lastItem, sequenceIndent)
      return {
        span: { start: lines[firstItem]!.start, end },
        itemIndent: sequenceIndent,
        empty: false,
        appendAt: end,
        lineEnding,
      }
    }
    throw new PatchFormatError(file, `the "${id}" row has no servers list`)
  }
  throw new PatchFormatError(file, `the file has no "${id}" row`)
}

/**
 * The indentation of a block sequence's own items.
 *
 * The first line after the key that is indented deeper and starts an item is the
 * one that fixes the indentation; every sibling item shares it.
 *
 * @param lines - The file's lines.
 * @param from - Index of the key line.
 * @param until - Byte offset the row ends at.
 * @param keyIndent - The indentation of the key itself.
 * @returns The item indentation, or the key's plus two when there is no item.
 */
function firstItemIndent(
  lines: readonly SourceLine[],
  from: number,
  until: number,
  keyIndent: number,
): number {
  for (let scan = from + 1; scan < lines.length; scan += 1) {
    const body = lines[scan]!
    if (body.start >= until) break
    if (body.text.trim() === '' || body.text.trimStart().startsWith('#')) continue
    if (body.indent <= keyIndent) break
    if (/^\s*-\s/.test(body.text)) return body.indent
  }
  return keyIndent + 2
}

/**
 * Strip one layer of matching quotes from a YAML scalar.
 *
 * @param value - The raw scalar text.
 * @returns The scalar without surrounding quotes.
 */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/**
 * Render a server entry as the YAML block an `mcp-lazy.servers` item uses.
 *
 * The whole entry is re-indented from the block `yaml.dump` produces rather than
 * relying on js-yaml's own indent handling, because the first line carries the
 * dash: the dash sits at one column and the entry's keys at the next one in, and
 * a dump indented for the keys alone would put the dash one column too deep —
 * turning the new server into a nested child of the previous one. That is a
 * corrupt file, not a cosmetic difference, so the arithmetic is done here once.
 *
 * Values are re-serialised here, which is safe in a way the file as a whole is
 * not: the entry came from a row that was fully parsed, `!!js`-free, and made
 * only of fields this plugin implements. Its original formatting carries no
 * meaning the way the surrounding file's comments do.
 *
 * @param entry - The server configuration to write.
 * @param dashIndent - The column the item's `-` sits at.
 * @param lineEnding - The line ending the file uses. Taken from the file rather
 * than assumed, so a file written on Windows is not left with mixed endings by an
 * edit that only meant to add one entry.
 * @returns YAML text, with no trailing newline.
 */
export function renderServerEntry(
  entry: Record<string, unknown>,
  dashIndent: number,
  lineEnding = '\n',
): string {
  const body = yaml
    .dump(entry, { schema: ENTRY_SCHEMA, lineWidth: -1, noRefs: true, forceQuotes: false })
    .trimEnd()
    .split('\n')
  const dash = ' '.repeat(dashIndent)
  const key = ' '.repeat(dashIndent + 2)
  const [first = '', ...rest] = body
  return [`${dash}- ${first}`, ...rest.map(line => `${key}${line}`)].join(lineEnding)
}

/**
 * Insert `disabled: true` into a row.
 *
 * Two placements, because a row has two spellings and both are live:
 *
 * - a row that *mounts* the plugin has a `name:` line, and the flag goes right
 *   after it — one line long, next to the identity it disables, and preserved
 *   when the plugin that owns the row rewrites its block (`@hyzyn/dsh-codegraph`
 *   round-trips its managed block through js-yaml);
 * - a row that only *patches* one declared elsewhere has no `name:`, and the
 *   flag goes immediately before the first key that is not the row's own — i.e.
 *   before `config:`. Appending it at the end would put it inside a nested
 *   block, which is how a block scalar's contents get corrupted.
 *
 * The `name:` line is matched by its indentation, not by being the first line
 * that looks like a `name:` key. A row's content can contain anything — a block
 * scalar, an `env:` map — and one of those can hold a `name:` of its own.
 *
 * @param text - The row's text.
 * @param keyIndent - The indentation of the row's keys.
 * @param lineEnding - The line ending the file uses.
 * @returns The row's text with the line added.
 * @throws {PatchFormatError} When the row has no key column to attach to.
 */
export function insertDisabled(text: string, keyIndent: number, lineEnding = '\n'): string {
  const lines = splitSource(text)
  const ownKeys = lines.filter(line => line.indent === keyIndent && line.text.trim() !== '')
  /* v8 ignore next -- a row always has at least its own id line */
  if (ownKeys.length === 0) {
    throw new PatchFormatError('(row)', 'the row has no keys at its own indentation')
  }

  const name = ownKeys.find(line => /^name:(\s|$)/.test(line.text.slice(keyIndent)))
  const anchor =
    name ?? ownKeys.find(line => /^config:/.test(line.text.slice(keyIndent))) ?? ownKeys.at(-1)!
  const at = name === undefined ? anchor.start : anchor.start + anchor.text.length
  const flag = `${' '.repeat(keyIndent)}disabled: true`
  const before = name === undefined ? `${flag}${lineEnding}` : lineEnding
  const after = name === undefined ? '' : flag
  return `${text.slice(0, at)}${before}${after}${text.slice(at)}`
}

/**
 * Replace a span of a file with new text.
 *
 * @param text - The file's contents.
 * @param span - The character range to replace.
 * @param replacement - The replacement text.
 * @returns The new contents.
 */
export function splice(text: string, span: Span, replacement: string): string {
  return text.slice(0, span.start) + replacement + text.slice(span.end)
}
