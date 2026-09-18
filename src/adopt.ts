/**
 * Plan the move of `@deepseek-ai/dsh-mcp-client` servers into this plugin.
 *
 * The problem this solves is a configuration split across two plugins. Every
 * writer of MCP configuration in this ecosystem emits a `dsh-mcp-client` row —
 * the config-manager panel hardcodes the package name, `@hyzyn/dsh-codegraph`
 * writes a managed row, and a hand-written config follows the same convention.
 * Such a row registers each MCP tool as a real tool, so its schemas enter every
 * request. This plugin exists to stop exactly that, and a server listed in both
 * places cancels the saving without failing anything: no name clash, no error,
 * nothing to notice.
 *
 * The plan this module produces is a list of byte edits. Nothing here writes a
 * file, and nothing here evaluates a `!!js` expression.
 *
 * @module dsh-mcp-lazy/adopt
 */

import { LAZY_PLUGIN, NATIVE_MCP_PLUGIN, type ComposedRow } from './adopt-compose.js'
import {
  findNativeRow,
  findServersList,
  insertDisabled,
  renderServerEntry,
  splice,
  type NativeRow,
} from './adopt-patch.js'
import { KNOWN_SERVER_FIELDS, MCP_CLIENT_ONLY_FIELDS } from './index.js'

export type { NativeRow } from './adopt-patch.js'

/**
 * Why a native row was left alone.
 *
 * Every one of these is a deliberate decision, which is the point: a command
 * that silently skipped a row would leave the user believing the saving had been
 * restored. `--allow-skip` exists so a caller can accept the ones it has read.
 */
export type AdoptSkipReason =
  /** Already in this plugin's `servers`; nothing to add, but disable anyway. */
  | 'already-lazy'
  /** The row declares no `serverName`, so it cannot be addressed. */
  | 'missing-server-name'
  /** Carries a field this plugin does not implement (`reconnect`, …). */
  | 'unsupported-field'
  /** The same `serverName` appears on more than one row. */
  | 'duplicate-native'
  /** Contains a `!!js` expression, which a text rewrite must not touch. */
  | 'js-expression'
  /** Not a configuration this plugin could load (stdio without a command, …). */
  | 'cannot-work'
  /** The dump reported it but no file this command may edit declares it. */
  | 'unresolved'

/** A server entry, in the shape this plugin's `servers` list accepts. */
export type ServerEntryInput = Record<string, unknown>

/** A field-by-field description of one planned edit. */
export interface PlannedEdit {
  /** The file the edit lands in. */
  file: string
  /** The row the edit belongs to: its loader id, or `mcp-lazy` for an append. */
  id: string
  /** The server the row configures, when it declares one. */
  serverName?: string
  /** `adopt` appends to this plugin's `servers`; `disable` marks the native row. */
  kind: 'adopt' | 'disable'
  /**
   * Where the replacement starts, as an index into the file's text.
   *
   * A *character* index, not a byte offset: JavaScript strings are sequences of
   * UTF-16 code units, and these are the offsets `slice` and `splice` take. For
   * a file containing non-ASCII text the two differ — which is why the ranges
   * are consumed with `String.prototype.slice` here rather than handed to a tool
   * that would read them as bytes.
   */
  start: number
  /** One past the last character the replacement covers. */
  end: number
  /** The replacement text. */
  replacement: string
}

/** Everything the command intends to do, and everything it refuses to. */
export interface AdoptPlan {
  /** Servers to add to this plugin, and the rows they came from. */
  adoptions: Array<{ source: NativeRow; entry: ServerEntryInput }>
  /** Native rows to mark `disabled: true`, in place. */
  disables: Array<{ id: string; file: string; serverName?: string }>
  /**
   * Every row that was left alone, each with a reason.
   *
   * Includes rows that needed nothing (already inert, no `serverName`) as well
   * as refusals; `blocked` is the count of the second kind, which is the one
   * that decides the exit code.
   */
  skips: Array<{ source: NativeRow; reason: AdoptSkipReason; detail?: string }>
  /**
   * How many rows should have moved and did not.
   *
   * Zero means the configuration is in its end state for every row this command
   * can see, whatever the row count — which is what makes a second `--write`
   * exit 0 instead of reporting the first run's work as a problem.
   */
  blocked: number
  /**
   * The edit script: every byte the command would change.
   *
   * Applying these ranges (descending by `start`) to the original files produces
   * the rewritten files exactly. That makes the "every other byte is untouched"
   * claim checkable rather than asserted, and it is what the AD4 test does.
   *
   * The claim holds *byte* for byte even though the offsets are character
   * indices, because a range is cut on the characters it names: everything
   * outside them is carried across unchanged, whatever its encoding.
   */
  edits: PlannedEdit[]
  /** The files the edit script touches, deduplicated. */
  files: string[]
}

/** The context a plan needs that is not in the composed tree itself. */
export interface AdoptionInput {
  /** Every `dsh-mcp-client` row, with the file it can be rewritten in. */
  nativeRows: readonly NativeRow[]
  /** The composed `servers` list of this plugin, if it is configured at all. */
  existingServers: readonly ServerEntryInput[]
  /** The file carrying this plugin's `id: mcp-lazy` row, when there is one. */
  gatewayFile?: string
  /**
   * Read a file's current contents.
   *
   * Passed in rather than reached for so the planner stays pure: a test hands it
   * a string, the command hands it `readFileSync`.
   */
  read: (file: string) => string
}

/**
 * Fields that belong to the loader row rather than to the server.
 *
 * `serverName` is deliberately absent: it is the server's own name, it is the
 * first thing a reader looks for, and it has to be written first. The row's `id`
 * and plugin `name` describe the row and are dropped.
 */
const ROW_ONLY_FIELDS = new Set(['id', 'name'])

/**
 * The order server fields are written in.
 *
 * js-yaml keeps insertion order, so the order this list is applied in is the
 * order the entry lands in the user's file. `serverName` first and `transport`
 * second matches every hand-written example and the schema itself; the rest
 * follow the schema's declaration order, so a ported entry looks like one a
 * person would have written rather than like the order the source row happened
 * to use.
 */
const SERVER_FIELD_ORDER = [
  'serverName',
  'transport',
  'command',
  'args',
  'env',
  'envFrom',
  'allowEmpty',
  'envFromTimeoutMs',
  'cwd',
  'url',
  'headers',
  'toolCallTimeoutMs',
  'lifecycle',
  'idleTimeout',
  'directTools',
  'includeTools',
  'excludeTools',
  'searchKeywords',
  'disabled',
  'debug',
]

/**
 * Resolve composed rows into the file-backed rows a plan can edit.
 *
 * The composed dump says *what* is mounted; a plan needs *where each row is
 * written*. Those are different questions — a patch layer inserts a row into a
 * base file's tree, so the dump attributes a row to the layer that patched it,
 * not to the plugin it names — and this is where they are joined.
 *
 * A row that cannot be located in any file is returned as an *unresolved* row
 * rather than dropped. Dropping it is the one outcome the whole command exists
 * to prevent: the dump would say the server is mounted and running, the plan
 * would say "nothing to do", and the saving would stay cancelled while the
 * command reported success.
 *
 * @param composedRows - The rows as the dump declared them.
 * @param read - Reads a file's contents.
 * @returns The rows, each resolvable or explicitly unresolved.
 */
export function resolveNativeRows(
  composedRows: readonly ComposedRow[],
  read: (file: string) => string,
  candidateFiles: readonly string[] = [],
): NativeRow[] {
  const rows: NativeRow[] = []
  for (const composed of composedRows) {
    const id = typeof composed.entry.id === 'string' ? composed.entry.id : ''
    const name = typeof composed.entry.name === 'string' ? composed.entry.name : NATIVE_MCP_PLUGIN
    const serverName =
      typeof (composed.entry.config as { serverName?: unknown } | undefined)?.serverName === 'string'
        ? ((composed.entry.config as { serverName: string }).serverName)
        : undefined
    const named = sameName(serverName)

    if (id === '') {
      rows.push(unresolvedRow(id, name, composed, named, '(the dump reports no id for this row)'))
      continue
    }

    // Where a row lives is a question about the files, not about the marker: a
    // layer that patches a row declared in another file changes the marker, and
    // the layer order in it does not say which file holds the `- id:` line. So
    // every editable file is asked, in order, and the row that declares itself
    // as a mounted plugin wins — that is the one the loader treats as the row.
    const candidates: NativeRow[] = []
    for (const file of candidateFiles) {
      const layer = file.endsWith('cordis.patch.yml') && !file.includes('/profiles/')
        ? 'home'
        : 'profile'
      const found = findNativeRow(read(file), id, file, layer)
      if (found !== undefined) candidates.push(found)
    }
    if (composed.file !== undefined && composed.layer !== 'unknown' && !candidateFiles.includes(composed.file)) {
      const found = findNativeRow(read(composed.file), id, composed.file, composed.layer)
      if (found !== undefined) candidates.push(found)
    }

    const found = candidates.find(candidate => candidate.name === NATIVE_MCP_PLUGIN) ?? candidates[0]
    rows.push(
      found ??
        unresolvedRow(
          id,
          name,
          composed,
          named,
          composed.file ?? '(no file named by the dump)',
        ),
    )
  }
  return rows
}

/**
 * The server name a row carries, when it has one worth reporting.
 *
 * @param serverName - The `serverName` a composed entry carries.
 * @returns The name, or undefined.
 */
function sameName(serverName: string | undefined): string | undefined {
  return serverName !== undefined && serverName !== '' ? serverName : undefined
}

/**
 * A row that could not be tied back to a file this command may edit.
 *
 * It carries no range into a file, because there is nothing to edit — the plan refuses
 * it and the command says so. That is deliberately louder than silence: this is
 * the shape a `--patch` overlay takes, and the shape of a row whose only file is
 * one this command does not write to, and in both cases the row is live
 * configuration.
 *
 * @param id - The loader id the dump reported.
 * @param name - The package the dump reported the row mounts.
 * @param composed - The row as the dump declared it.
 * @param serverName - The server the row configures, when known.
 * @param origin - Where the dump said the row came from, for the message.
 * @returns A row the planner will refuse, with a reason.
 */
function unresolvedRow(
  id: string,
  name: string,
  composed: ComposedRow,
  serverName: string | undefined,
  origin: string,
): NativeRow {
  return {
    id: id === '' ? '(unnamed)' : id,
    ...(serverName === undefined ? {} : { serverName }),
    raw: '',
    fields: { id, name },
    layer: composed.layer === 'home' ? 'home' : 'profile',
    file: origin,
    span: { start: 0, end: 0 },
    keyIndent: 0,
    disabled: composed.entry.disabled === true,
    jsExpression: false,
    origin,
  }
}

/**
 * Work out what to do with every native row.
 *
 * @param input - The composed rows, the existing config, and a file reader.
 * @returns The plan, including the byte edits that would carry it out.
 * @throws {Error} When this plugin's `servers` list cannot be located for an
 * adoption, which would mean writing a destructive config change.
 */
export function planAdoption(input: AdoptionInput): AdoptPlan {
  const adoptions: AdoptPlan['adoptions'] = []
  const disables: AdoptPlan['disables'] = []
  const skips: AdoptPlan['skips'] = []
  const edits: PlannedEdit[] = []
  let blocked = 0

  const lazyNames = new Set(
    input.existingServers
      .map(entry => entry['serverName'])
      .filter((name): name is string => typeof name === 'string' && name !== ''),
  )

  // Duplicates are counted first: a name on two rows is a name neither of them
  // can use, and the answer must not depend on which row is visited first.
  const nameCounts = new Map<string, number>()
  for (const row of input.nativeRows) {
    if (row.serverName === undefined) continue
    nameCounts.set(row.serverName, (nameCounts.get(row.serverName) ?? 0) + 1)
  }

  /** Record a row as deliberately skipped. */
  const skip = (source: NativeRow, reason: AdoptSkipReason, detail?: string): void => {
    skips.push({ source, reason, ...(detail === undefined ? {} : { detail }) })
  }

  /** Record a row that should have moved but did not, and say why. */
  const refuse = (source: NativeRow, reason: AdoptSkipReason, detail?: string): void => {
    blocked += 1
    skip(source, reason, detail)
  }

  for (const row of input.nativeRows) {
    // Two different things are recorded in `skips`, and only one of them is a
    // failure. A row that is already inert, or that names no server, or that was
    // refused for a reason the user cannot act on, leaves nothing to do — and a
    // configuration in that state must be able to exit 0, or `--write` twice in a
    // row would be a failure the second time. A row that *should* have moved and
    // did not is the real skip: the saving is still cancelled for that server.
    //
    // The distinction is decided by what the plugin does, not by what the row
    // is: the exit code is a claim about the move, not about the rows.
    if (row.origin !== undefined) {
      refuse(
        row,
        'unresolved',
        `the composed configuration reports this row (from ${row.origin ?? 'an unnamed layer'}) but ` +
          'no file this command may edit declares it — it comes from a --patch overlay, or the ' +
          'file that holds it is not one of the patch layers. Move it by hand, or drop the overlay',
      )
      continue
    }

    if (row.disabled) {
      // Already inert. Disabling it again would not be idempotent, and there is
      // nothing left for it to cost.
      skip(row, 'already-lazy', 'the row already carries disabled: true')
      continue
    }

    if (row.serverName === undefined || row.serverName === '') {
      // The other plugin requires `serverName`, so such a row never worked and
      // never cost anything.
      skip(row, 'missing-server-name', 'the row declares no serverName, so it never mounted')
      continue
    }

    // The id says which row this is; the config's own serverName is the
    // server's. They can only disagree if the file was edited by hand into a
    // state the loader itself would report as one thing and a reader as another.
    const declared = row.fields['serverName']
    if (typeof declared === 'string' && declared !== '' && declared !== row.serverName) {
      refuse(
        row,
        'missing-server-name',
        `the row's id names "${row.serverName}" but its config says "${declared}"`,
      )
      continue
    }

    const unsupported = Object.keys(row.fields).find(field =>
      MCP_CLIENT_ONLY_FIELDS.has(field),
    )
    if (unsupported !== undefined) {
      refuse(
        row,
        'unsupported-field',
        `"${unsupported}" is not implemented by this plugin: ${MCP_CLIENT_ONLY_FIELDS.get(unsupported) ?? ''}`.trim(),
      )
      continue
    }

    if (row.jsExpression) {
      refuse(
        row,
        'js-expression',
        'the row contains a !!js expression, which a text-level rewrite must not touch',
      )
      continue
    }

    if ((nameCounts.get(row.serverName) ?? 0) > 1) {
      refuse(
        row,
        'duplicate-native',
        `"${row.serverName}" is configured on more than one row; @deepseek-ai/dsh-mcp-client refuses duplicate server names too`,
      )
      continue
    }

    const entry = serverEntryFrom(row)
    const broken = whyItCannotWork(entry)
    if (broken !== undefined) {
      refuse(row, 'cannot-work', broken)
      continue
    }

    const alreadyLazy = lazyNames.has(row.serverName)
    if (alreadyLazy) {
      // Distinct from "nothing to do": the row still has to be disabled, which
      // is the half an earlier version of this design got wrong.
      skip(row, 'already-lazy', 'already present in this plugin\'s servers list')
    } else {
      adoptions.push({ source: row, entry })
    }
    disables.push({
      id: row.id,
      file: row.file,
      serverName: row.serverName,
    })
  }

  for (const disable of disables) {
    const row = input.nativeRows.find(
      candidate => candidate.id === disable.id && candidate.file === disable.file,
    )
    /* v8 ignore next -- every disable is created from a row in the same list */
    if (row === undefined) continue
    const text = input.read(row.file)
    const replacement = insertDisabled(row.raw, row.keyIndent, lineEndingOf(text))
    edits.push({
      file: row.file,
      id: row.id,
      serverName: row.serverName ?? '',
      kind: 'disable',
      start: row.span.start,
      end: row.span.end,
      replacement,
    })
  }

  if (adoptions.length > 0) {
    edits.push(...planServerAppends(input, adoptions))
  }

  return {
    adoptions,
    disables,
    skips,
    blocked,
    edits,
    files: [...new Set(edits.map(edit => edit.file))],
  }
}

/**
 * The line ending a file uses.
 *
 * @param text - The file's contents.
 * @returns `\r\n` when the file is a CRLF file, `\n` otherwise.
 */
function lineEndingOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * Plan the edit that adds adopted servers to this plugin's `servers` list.
 *
 * One edit, anchored at the end of the existing list, rather than one per
 * server: appending to a sequence is an insertion at a single point, and the
 * offets of everything before it stay valid because edits are applied back to
 * front.
 *
 * @param input - The plan's input, for the gateway file and the reader.
 * @param adoptions - The servers to add, in order.
 * @returns The append edit.
 * @throws {Error} When there is nowhere to put the servers.
 */
function planServerAppends(
  input: AdoptionInput,
  adoptions: AdoptPlan['adoptions'],
): PlannedEdit[] {
  const file = input.gatewayFile
  if (file === undefined) {
    throw new Error(
      `found ${adoptions.length} server(s) to move but no "${LAZY_PLUGIN}" row to move them into; ` +
        `add an \`- id: ${LAZY_PLUGIN}\` entry with a \`servers\` list first`,
    )
  }
  const text = input.read(file)
  const list = findServersList(text, LAZY_PLUGIN, file)
  const eol = list.lineEnding
  const rendered = adoptions
    .map(adoption => renderServerEntry(adoption.entry, list.itemIndent, eol))
    .join(eol)

  if (list.empty) {
    // `servers:` with nothing under it, or `servers: []`. There is no content to
    // preserve, so the key itself is replaced by the key plus a block list.
    const line = text.slice(list.span.start, list.span.end)
    const key = /^(\s*servers):/.exec(line)
    /* v8 ignore next -- findServersList only returns spans that start with the key */
    const keyText = key === null ? 'servers:' : `${key[1]}:`
    return [
      {
        file,
        id: LAZY_PLUGIN,
        kind: 'adopt',
        start: list.span.start,
        end: list.span.end,
        replacement: `${keyText}${eol}${rendered}`,
      },
    ]
  }

  // The insertion point is the end of the last server entry, which is usually
  // the end of a line — so the entry may need a leading break, a trailing one,
  // or both. "The end of a line" means the end of *that file's* line: the bytes
  // between the insertion point and the next line's content may be an LF or a
  // CRLF, and assuming an LF either splits a CRLF pair or adds a second blank
  // line to a file that ended with one.
  const at = list.appendAt
  const needsLeadingBreak = at > 0 && text[at - 1] !== '\n'
  const following = /^\r?\n/.exec(text.slice(at))?.[0]
  const trailing = following ?? (at >= text.length ? eol : '')
  return [
    {
      file,
      id: LAZY_PLUGIN,
      kind: 'adopt',
      start: at,
      end: at,
      replacement: `${needsLeadingBreak ? eol : ''}${rendered}${text.slice(at).startsWith(trailing) ? '' : trailing}`,
    },
  ]
}

/**
 * Translate one `dsh-mcp-client` row into an entry this plugin can load.
 *
 * The two plugins' server fields are synonyms (F6), so a row moves across with
 * no translation. Two exceptions are handled rather than passed through:
 *
 * - `cwd` defaults to the empty string on the other side, and `cwd: ''` means
 *   "unset" to a subprocess while looking like a configured directory to a
 *   reader. It is dropped.
 * - `id` identifies the *loader row*, not the server. Carrying it into
 *   `servers` would put a meaningless key in the user's config.
 *
 * @param row - The row to translate.
 * @returns A server entry, with only fields this plugin implements.
 */
export function serverEntryFrom(row: NativeRow): ServerEntryInput {
  const entry: ServerEntryInput = {}
  const wanted = (key: string): boolean =>
    !ROW_ONLY_FIELDS.has(key) && KNOWN_SERVER_FIELDS.has(key)
  for (const key of SERVER_FIELD_ORDER) {
    if (!wanted(key)) continue
    const value = row.fields[key]
    if (value === null || value === undefined) continue
    if (key === 'cwd' && value === '') continue
    entry[key] = value
  }
  // A field this plugin implements but the order list forgot still has to move
  // across: dropping it silently is the failure mode this whole command is
  // about. It lands at the end, which is the right place for the unexpected.
  for (const [key, value] of Object.entries(row.fields)) {
    if (!wanted(key) || key in entry) continue
    if (value === null || value === undefined) continue
    if (key === 'cwd' && value === '') continue
    entry[key] = value
  }
  if (typeof row.serverName === 'string' && row.serverName !== '') {
    entry['serverName'] = row.serverName
  }
  return entry
}

/**
 * Explain why this plugin would refuse to load an entry, if it would.
 *
 * `apply` throws on these, so adopting one would turn a working configuration
 * into a plugin that fails to load. The plan reports it and leaves the row where
 * it is instead.
 *
 * @param entry - The candidate server entry.
 * @returns A human-readable reason, or undefined when the entry is loadable.
 */
function whyItCannotWork(entry: ServerEntryInput): string | undefined {
  const name = typeof entry['serverName'] === 'string' ? entry['serverName'] : '(unnamed)'
  if (entry['transport'] === 'stdio' && (entry['command'] === undefined || entry['command'] === '')) {
    return `server "${name}" uses transport stdio but has no command`
  }
  if (
    entry['transport'] === 'streamable-http' &&
    (entry['url'] === undefined || entry['url'] === '')
  ) {
    return `server "${name}" uses transport streamable-http but has no url`
  }
  if (entry['transport'] === undefined) {
    return `server "${name}" declares no transport; @deepseek-ai/dsh-mcp-client requires one`
  }
  return undefined
}

/** A one-line summary of a plan, for a human reading a dry run. */
export function summarizePlan(plan: AdoptPlan): string {
  const lines: string[] = []
  lines.push(
    `${plan.adoptions.length} server(s) to move, ${plan.disables.length} row(s) to disable, ` +
      `${plan.skips.length} row(s) needing no action, ${plan.blocked} blocked`,
  )
  for (const adoption of plan.adoptions) {
    lines.push(`  adopt   ${adoption.source.serverName} (from ${adoption.source.id} in ${adoption.source.file})`)
  }
  for (const disable of plan.disables) {
    lines.push(`  disable ${disable.id}${disable.serverName === undefined ? '' : ` (${disable.serverName})`} in ${disable.file}`)
  }
  for (const skipped of plan.skips) {
    lines.push(
      `  skip    ${skipped.source.serverName ?? skipped.source.id}: ${skipped.reason}` +
        `${skipped.detail === undefined ? '' : ` — ${skipped.detail}`}`,
    )
  }
  return lines.join('\n')
}

/**
 * Apply a plan's edit script to one file's contents.
 *
 * Edits are applied back to front so an earlier edit cannot move a later one's
 * offsets. Overlapping edits are a programming error and throw rather than
 * producing a plausible-looking wrong file.
 *
 * @param text - The file's current contents.
 * @param edits - The edits for this file.
 * @returns The rewritten contents.
 * @throws {Error} When two edits overlap.
 */
export function applyEdits(
  text: string,
  edits: readonly { start: number; replacement: string; end?: number }[],
): string {
  const ordered = [...edits].sort((left, right) => right.start - left.start)
  let result = text
  let boundary = Number.POSITIVE_INFINITY
  for (const edit of ordered) {
    const end = edit.end ?? edit.start
    if (end > boundary) {
      throw new Error(`adopt: two edits overlap at byte ${edit.start}`)
    }
    result = splice(result, { start: edit.start, end }, edit.replacement)
    boundary = edit.start
  }
  return result
}

export { NATIVE_MCP_PLUGIN, LAZY_PLUGIN }
