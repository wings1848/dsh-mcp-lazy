/**
 * The adopt command's decision logic and byte-level surgery.
 *
 * Two things are being defended here, and they are different in kind.
 *
 * The first is a *decision*: which rows may move, which must not, and why. A row
 * this command silently skipped leaves the user believing the token saving came
 * back when it did not, so every skip is asserted to carry a reason.
 *
 * The second is *bytes*. The files being edited are somebody's only
 * configuration, full of hand-written comments and `!!js` expressions that no
 * parse-and-dump round trip preserves. So the invariant tested here is not "the
 * result parses" but "the result is the original with exactly these ranges
 * replaced" — the edits are applied to the original, and everything outside them
 * is compared byte for byte.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { fileOfMarker, parseComposedDump } from '../../lib/adopt-compose.js'
import {
  findNativeRow,
  findServersList,
  insertDisabled,
  renderServerEntry,
  splitSource,
} from '../../lib/adopt-patch.js'
import {
  applyEdits,
  planAdoption,
  resolveNativeRows,
  serverEntryFrom,
  summarizePlan,
} from '../../lib/adopt.js'

/** A home layer in the shape the codegraph plugin writes: a marked block. */
const HOME = [
  '# --- dsh-codegraph mcp managed (auto-generated; do not edit) ---',
  '- insert:',
  '    - id: mcp-codegraph-managed',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: codegraph',
  '        transport: stdio',
  '        command: codegraph',
  '        args:',
  '          - serve',
  "          - '--mcp'",
  '        cwd: /home/wings',
  '# --- end dsh-codegraph mcp managed ---',
  '',
].join('\n')

/** A profile layer in the shape this plugin's own configuration uses. */
const PROFILE = [
  '# Hand-written notes belong to whoever wrote them, and are not ours to reformat.',
  '- id: mcp-lazy',
  '  config:',
  '    idleTimeout: 10        # inline comments too',
  '    outputGuard: true',
  '    servers:',
  '      - serverName: phonemcp',
  '        transport: stdio',
  '        command: /usr/bin/python',
  '        args:',
  '          - main.py',
  '          - "-t"',
  '          - stdio',
  '        searchKeywords:',
  '          "*": ["\\u624b\\u673a", "adb"]',
  '      - serverName: browser-rendering',
  '        transport: stdio',
  '        command: npx',
  '        disabled: !!js "!process.env.CF_BROWSER_TOKEN"',
  `        args: !!js "['-y', 'chrome-devtools-mcp@latest']"`,
  '',
].join('\n')

/** The absolute paths the fixtures pretend to live at. */
const HOME_FILE = '/sandbox/cordis.patch.yml'
const PROFILE_FILE = '/sandbox/profiles/web/cordis.patch.yml'

/** A composed dump listing the two layers above, plus the gateway's servers. */
const DUMP = [
  '# == @deepseek-ai/dsh-base',
  '- id: webserver',
  "  name: '@deepseek-ai/dsh-webserver'",
  `# == ${HOME_FILE}`,
  '- id: mcp-codegraph-managed',
  "  name: '@deepseek-ai/dsh-mcp-client'",
  '  config:',
  '    serverName: codegraph',
  '    transport: stdio',
  '    command: codegraph',
  '    args:',
  '      - serve',
  "      - '--mcp'",
  '    cwd: /home/wings',
  `# == dsh-mcp-lazy, patched by ${PROFILE_FILE}`,
  '- id: mcp-lazy',
  '  config:',
  '    idleTimeout: 10',
  '    servers:',
  '      - serverName: phonemcp',
  '        transport: stdio',
  '        command: /usr/bin/python',
  '',
].join('\n')

/** The `disabled: true` line the command inserts into the `HOME` fixture's row. */
const DISABLED_LINE = '      disabled: true\n'

/**
 * A fixture with one line replaced, matched by its trimmed content.
 *
 * Two layers of quoting are being crossed here — a YAML file inside a template —
 * and the fixtures deliberately contain `!!js` expressions with `$` and quotes in
 * them. Matching on the trimmed line and re-indenting removes both problems:
 * `String.prototype.replace` expands `$&` and `` $` `` inside a *string*
 * replacement, which silently corrupts such a fixture, so the replacement is
 * always a function here. And an indentation-insensitive match means a test says
 * what it changes rather than how deeply it happens to be nested.
 *
 * @param text - The fixture to edit.
 * @param line - The trimmed line to find.
 * @param replacement - The replacement's trimmed text, or a list of trimmed lines
 * to splice in place of the one found. An empty list deletes the line.
 * @returns The edited fixture.
 */
function swapLine(text: string, line: string, replacement: string | string[]): string {
  const lines = text.split('\n')
  const index = lines.findIndex(candidate => candidate.trim() === line)
  if (index === -1) throw new Error(`fixture has no line "${line}"`)
  const indent = /^\s*/.exec(lines[index]!)?.[0] ?? ''
  const replacementLines = (Array.isArray(replacement) ? replacement : [replacement]).map(
    entry => `${indent}${entry}`,
  )
  lines.splice(index, 1, ...replacementLines)
  return lines.join('\n')
}

/**
 * The composed tree for the two fixtures, with a reader that serves them.
 *
 * @param files - Overrides for either file's contents.
 * @returns The parsed composed tree, a reader for the planner, and the files.
 */
function sandbox(files: { home?: string; profile?: string } = {}): {
  composed: ReturnType<typeof parseComposedDump>
  read: (file: string) => string
  contents: Map<string, string>
} {
  const contents = new Map<string, string>([
    [HOME_FILE, files.home ?? HOME],
    [PROFILE_FILE, files.profile ?? PROFILE],
  ])
  return {
    composed: parseComposedDump(DUMP, '/sandbox', '/sandbox/profiles/web'),
    read: file => {
      const text = contents.get(file)
      if (text === undefined) throw new Error(`unexpected read of ${file}`)
      return text
    },
    contents,
  }
}

/**
 * Plan an adoption over the fixtures.
 *
 * @param files - Overrides for either file's contents.
 * @param existing - The servers this plugin is already configured with.
 * @returns The plan and the fixtures it was made from.
 */
function plan(
  files: { home?: string; profile?: string } = {},
  existing?: unknown[],
): { plan: ReturnType<typeof planAdoption>; contents: Map<string, string> } {
  const box = sandbox(files)
  const rows = resolveNativeRows(box.composed.nativeRows, box.read)
  return {
    contents: box.contents,
    plan: planAdoption({
      nativeRows: rows,
      existingServers: (existing ?? box.composed.gateway?.servers ?? []) as Record<string, unknown>[],
      gatewayFile: box.composed.gateway?.file,
      read: box.read,
    }),
  }
}

/**
 * Plan a single row from one file, which is all the refusal cases need.
 *
 * @param home - The home layer's contents.
 * @param existing - This plugin's configured servers.
 * @returns The plan.
 */
function planOne(home: string, existing: unknown[] = []): ReturnType<typeof planAdoption> {
  const row = findNativeRow(home, 'ported', HOME_FILE, 'home')
  if (row === undefined) throw new Error('fixture has no "ported" row')
  return planAdoption({
    nativeRows: [row],
    existingServers: existing as Record<string, unknown>[],
    gatewayFile: PROFILE_FILE,
    read: file => (file === HOME_FILE ? home : PROFILE),
  })
}

/**
 * Apply a plan's edits for one file, the way the command does.
 *
 * @param contents - The fixture's files.
 * @param result - The plan.
 * @param file - Which file to rewrite.
 * @returns The rewritten contents.
 */
function rewritten(
  contents: Map<string, string>,
  result: ReturnType<typeof planAdoption>,
  file: string,
): string {
  return applyEdits(
    contents.get(file)!,
    result.edits.filter(edit => edit.file === file),
  )
}

/**
 * The home fixture with its row renamed, so one case can be reasoned about alone.
 *
 * @param home - The fixture to rename in.
 * @returns The renamed fixture.
 */
function ported(home: string = HOME): string {
  return swapLine(home, '- id: mcp-codegraph-managed', '- id: ported')
}

describe('parseComposedDump', () => {
  it('attributes each row to the patch layer that wrote it', () => {
    // A patch layer inserts into a base file's tree, so the dump's marker reads
    // `origin, patched by <layer>`. The layer is where the bytes are, and it is
    // the only link back to an editable file.
    const { composed } = sandbox()
    assert.equal(composed.nativeRows.length, 1)
    assert.equal(composed.nativeRows[0]!.file, HOME_FILE)
    assert.equal(composed.nativeRows[0]!.layer, 'home')
    assert.equal(composed.gateway?.file, PROFILE_FILE)
    assert.equal(composed.gateway?.layer, 'profile')
  })

  it('keeps the composed servers of this plugin', () => {
    const { composed } = sandbox()
    assert.deepEqual(
      composed.gateway?.servers.map(entry => entry['serverName']),
      ['phonemcp'],
    )
  })

  it('separates overlay rows from editable ones', () => {
    // A `--patch` overlay is a legal layer this command does not write to. Rows
    // from it must be reported, never edited.
    const text = [
      '# == /tmp/extra.yml',
      '- insert:',
      '    - id: from-overlay',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: overlay-server',
      '        transport: stdio',
      '        command: x',
      '',
    ].join('\n')
    const composed = parseComposedDump(text, '/sandbox', '/sandbox/profiles/web')
    assert.equal(composed.nativeRows.length, 0)
    assert.equal(composed.overlays.length, 1)
    assert.equal(composed.overlays[0]!.layer, 'unknown')
  })

  it('resolves a marker to the file a rewrite would edit', () => {
    assert.equal(fileOfMarker('@deepseek-ai/dsh-base'), '@deepseek-ai/dsh-base')
    assert.equal(
      fileOfMarker('dsh-mcp-lazy, patched by /home/w/.dsh/profiles/web/cordis.patch.yml'),
      '/home/w/.dsh/profiles/web/cordis.patch.yml',
    )
    // The layer label is cut at the next comma: the answer is a file path, and
    // it is the first one in the list that a rewrite can actually reach.
    assert.equal(fileOfMarker('a, patched by /one.yml, /two.yml'), '/one.yml')
  })

  it('ignores a layer it cannot parse instead of failing', () => {
    // Refusing to run because some unrelated plugin's patch is exotic would make
    // the command useless on any real machine.
    const text = [
      '# == /sandbox/cordis.patch.yml',
      "- insert: [{ id: ok, name: '@deepseek-ai/dsh-mcp-client', config: { serverName: s } }]",
      '# == /tmp/broken.yml',
      '- this: [is: not: yaml',
      '',
    ].join('\n')
    const composed = parseComposedDump(text, '/sandbox', '/sandbox/profiles/web')
    assert.equal(composed.nativeRows.length, 1)
  })

  it('reads a row through a group as well as an insert', () => {
    const text = [
      '# == /sandbox/cordis.patch.yml',
      '- id: outer',
      '  group: true',
      '  config:',
      '    - id: inner',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: grouped',
      '        transport: stdio',
      '        command: x',
      '',
    ].join('\n')
    const composed = parseComposedDump(text, '/sandbox', '/sandbox/profiles/web')
    assert.deepEqual(composed.nativeRows.map(row => row.entry.id), ['inner'])
  })
})

describe('findNativeRow', () => {
  it('locates a row nested under insert', () => {
    const row = findNativeRow(HOME, 'mcp-codegraph-managed', HOME_FILE, 'home')
    assert.notEqual(row, undefined)
    assert.equal(row!.serverName, 'codegraph')
    assert.equal(row!.keyIndent, 6)
    assert.equal(row!.disabled, false)
    assert.equal(row!.jsExpression, false)
  })

  it('reports the span as the exact bytes of the row, and only those', () => {
    // Not the enclosing `- insert:` block: two rows can share one block, and a
    // range covering both would disable the wrong one — or throw while the
    // second was being looked up.
    const row = findNativeRow(HOME, 'mcp-codegraph-managed', HOME_FILE, 'home')!
    assert.equal(row.raw, HOME.slice(row.span.start, row.span.end))
    assert.match(
      row.raw,
      /^- id: mcp-codegraph-managed\n {6}name: '@deepseek-ai\/dsh-mcp-client'\n {6}config:$/m,
    )
    assert.doesNotMatch(row.raw, /^- insert:/m)
    assert.equal(row.keyIndent, 6)
  })

  it('finds the second row of a block that holds two', () => {
    // The shape that used to make a whole file unprocessable: `parseRow` reads
    // the first item of an insert list, so looking up the second one threw with
    // the first one's id — and the caller was told the environment was broken.
    const two = [
      HOME.trimEnd(),
      '- insert:',
      '    - id: first',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: alpha',
      '        transport: stdio',
      '        command: x',
      '    - id: second',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: beta',
      '        transport: stdio',
      '        command: y',
      '',
    ].join('\n')
    const second = findNativeRow(two, 'second', HOME_FILE, 'home')!
    assert.equal(second.raw.split('\n')[0], '- id: second')
    assert.equal(second.fields['id'], 'second')
    assert.equal(second.serverName, 'beta')
    // Each row's range covers its own fields and neither of the other's.
    assert.doesNotMatch(second.raw, /alpha/)
    const first = findNativeRow(two, 'first', HOME_FILE, 'home')!
    assert.doesNotMatch(first.raw, /beta/)
  })

  it('sees a disabled row', () => {
    const text = swapLine(HOME, "name: '@deepseek-ai/dsh-mcp-client'", [
      "name: '@deepseek-ai/dsh-mcp-client'",
      'disabled: true',
    ])
    const row = findNativeRow(text, 'mcp-codegraph-managed', HOME_FILE, 'home')!
    assert.equal(row.disabled, true)
  })

  it('sees a !!js expression anywhere in the row', () => {
    const text = swapLine(HOME, 'command: codegraph', 'command: !!js pick()')
    const row = findNativeRow(text, 'mcp-codegraph-managed', HOME_FILE, 'home')!
    assert.equal(row.jsExpression, true)
  })

  it('returns undefined for an id the file does not declare', () => {
    assert.equal(findNativeRow(HOME, 'nope', HOME_FILE, 'home'), undefined)
  })

  it('flattens the config into the fields a server has', () => {
    const row = findNativeRow(HOME, 'mcp-codegraph-managed', HOME_FILE, 'home')!
    assert.deepEqual(Object.keys(row.fields).sort(), [
      'args',
      'command',
      'cwd',
      'id',
      'name',
      'serverName',
      'transport',
    ])
  })
})

describe('findServersList', () => {
  it('finds the end of the last item, not the end of its first line', () => {
    // The whole point: inserting after `- serverName: x` would put the new
    // server inside the previous one. A corrupt file, not a cosmetic slip.
    const list = findServersList(PROFILE, 'mcp-lazy', PROFILE_FILE)
    assert.equal(list.itemIndent, 6)
    assert.equal(list.empty, false)
    assert.match(
      PROFILE.slice(list.appendAt - 58, list.appendAt),
      /args: !!js "\['-y', 'chrome-devtools-mcp@latest'\]"$/,
    )
  })

  it('ignores nested sequences when finding the list', () => {
    // `args:` is a sequence too. A scan that accepted any `- ` would treat its
    // last entry as the last server.
    const list = findServersList(PROFILE, 'mcp-lazy', PROFILE_FILE)
    const span = PROFILE.slice(list.span.start, list.span.end)
    assert.match(span, /^ {6}- serverName: phonemcp$/m)
    assert.doesNotMatch(span.split('\n').at(-1)!, /^\s*- (serve|main\.py|stdio)/)
  })

  it('does not treat a trailing nested sequence as the last item', () => {
    // The shape that makes the indentation test load-bearing: when the last
    // server's `args` are block-style lines, a scan that accepted any `- ` would
    // take the last argument as the last server and append the new entry *after*
    // the `args` block — a mangled file, and one that still parses as something.
    const last = swapLine(PROFILE, `args: !!js "['-y', 'chrome-devtools-mcp@latest']"`, [
      'args:',
      "  - '-y'",
      '  - chrome-devtools-mcp@latest',
    ])
    const list = findServersList(last, 'mcp-lazy', PROFILE_FILE)
    // The insertion point is past the whole argument list, which is where the
    // last server entry ends.
    assert.equal(last.slice(list.appendAt, list.appendAt), '')
    assert.equal(last.slice(list.appendAt - 30, list.appendAt).trim(), '- chrome-devtools-mcp@latest')
    const next = `${last.slice(0, list.appendAt)}\n      - serverName: new${last.slice(list.appendAt)}`
    assert.match(next, /chrome-devtools-mcp@latest\n {6}- serverName: new\n$/)
  })

  it('reports an empty flow-style list', () => {
    const text = '- id: mcp-lazy\n  config:\n    servers: []\n'
    const list = findServersList(text, 'mcp-lazy', 'x.yml')
    assert.equal(list.empty, true)
    assert.equal(text.slice(list.span.start, list.span.end), 'servers: []')
  })

  it('reports an empty block-style list', () => {
    const text = '- id: mcp-lazy\n  config:\n    servers:\n'
    const list = findServersList(text, 'mcp-lazy', 'x.yml')
    assert.equal(list.empty, true)
  })

  it('keeps the file line ending rather than normalising it', () => {
    const text = '- id: mcp-lazy\r\n  config:\r\n    servers:\r\n      - serverName: a\r\n'
    const list = findServersList(text, 'mcp-lazy', 'x.yml')
    assert.equal(list.lineEnding, '\r\n')
  })

  it('writes a CRLF file with CRLF throughout (B6)', () => {
    // An edit that only meant to add one entry must not leave a file with mixed
    // endings: the diff then shows every line, and the next tool to read it has
    // to guess which convention won.
    const crlf = [
      '- id: mcp-lazy',
      '  config:',
      '    servers:',
      '      - serverName: a',
      '        transport: stdio',
      '        command: x',
      '',
    ].join('\r\n')
    const home = ['- id: native', "  name: '@deepseek-ai/dsh-mcp-client'", '  config:', '    serverName: b', '    transport: stdio', '    command: y', ''].join('\r\n')
    const contents = new Map([
      [HOME_FILE, home],
      [PROFILE_FILE, crlf],
    ])
    const row = findNativeRow(home, 'native', HOME_FILE, 'home')!
    const result = planAdoption({
      nativeRows: [row],
      existingServers: [],
      gatewayFile: PROFILE_FILE,
      read: file => contents.get(file)!,
    })
    const next = applyEdits(crlf, result.edits.filter(edit => edit.file === PROFILE_FILE))
    assert.equal(next.split('\n').length - 1, next.split('\r\n').length - 1, 'no LF-only line')
    assert.match(next, /^ {6}- serverName: b\r\n {8}transport: stdio\r\n {8}command: 'y'\r\n$/m)
  })

  it('accepts a trailing comment on the servers key', () => {
    // `servers:   # add servers below` is a block list with a note beside it.
    // Refusing it would reject the whole file over a punctuation choice.
    const text = [
      '- id: mcp-lazy',
      '  config:',
      '    servers:   # add servers below',
      '      - serverName: existing',
      '        transport: stdio',
      '        command: /bin/true',
      '',
    ].join('\n')
    const list = findServersList(text, 'mcp-lazy', 'x.yml')
    assert.equal(list.empty, false)
    assert.equal(list.itemIndent, 6)
    assert.equal(text.slice(list.appendAt - 18, list.appendAt), 'command: /bin/true')
  })

  it('refuses a flow-style list it cannot append to', () => {
    const text = '- id: mcp-lazy\n  config:\n    servers: [{ serverName: a }]\n'
    assert.throws(() => findServersList(text, 'mcp-lazy', 'x.yml'), /flow style/)
  })

  it('fails loudly when the row has no servers list at all', () => {
    assert.throws(
      () => findServersList('- id: mcp-lazy\n  config:\n    idleTimeout: 1\n', 'mcp-lazy', 'x.yml'),
      /no servers list/,
    )
  })

  it('fails loudly when the file has no such row', () => {
    assert.throws(() => findServersList('- id: other\n', 'mcp-lazy', 'x.yml'), /no "mcp-lazy" row/)
  })
})

describe('insertDisabled', () => {
  it('adds exactly one line, after name:', () => {
    const row = findNativeRow(HOME, 'mcp-codegraph-managed', HOME_FILE, 'home')!
    const next = insertDisabled(row.raw, row.keyIndent)
    assert.equal(next.split('\n').length, row.raw.split('\n').length + 1)
    assert.match(
      next,
      /^- id: mcp-codegraph-managed\n {6}name: '@deepseek-ai\/dsh-mcp-client'\n {6}disabled: true\n {6}config:$/m,
    )
    // Everything else is the same bytes.
    assert.equal(next.replace(DISABLED_LINE, ''), row.raw)
  })

  it('marks a row that has no name line, before its config', () => {
    // A row that only *patches* one declared elsewhere carries no `name:`. The
    // flag still has to be a sibling of the row's keys: appended at the end it
    // would land inside `config`, and inside a nested block that is a corrupt
    // file rather than a misplaced line.
    const next = insertDisabled('- id: x\n  config:\n    serverName: y\n', 2)
    assert.equal(next, '- id: x\n  disabled: true\n  config:\n    serverName: y\n')
  })

  it('marks a row whose name line comes after a nested block', () => {
    // The block scalar's body contains a line that looks like a `name:` key at
    // the same column as nothing in particular. Matching by indentation is what
    // keeps the flag a sibling of the row's own keys.
    const row = [
      '- id: x',
      '  config:',
      '    args:',
      '      - -c',
      '      - |',
      '        name: not-this-one',
      "  name: '@deepseek-ai/dsh-mcp-client'",
      '',
    ].join('\n')
    assert.equal(
      insertDisabled(row, 2),
      [
        '- id: x',
        '  config:',
        '    args:',
        '      - -c',
        '      - |',
        '        name: not-this-one',
        "  name: '@deepseek-ai/dsh-mcp-client'",
        '  disabled: true',
        '',
      ].join('\n'),
    )
  })

  it('is not fooled by a nested name: inside the row', () => {
    // A row's content can hold a `name:` of its own — in a block scalar, an
    // `env:` map, a nested object. Putting the flag after *that* one makes it a
    // line of the nested block instead of a sibling of the row's keys, which
    // turns a valid file into one the loader refuses.
    const row = [
      '- id: x',
      '  config:',
      '    args:',
      '      - -c',
      '      - |',
      '        name: not-the-row-name',
      '        world: 2',
      "  name: '@deepseek-ai/dsh-mcp-client'",
      '',
    ].join('\n')
    const next = insertDisabled(row, 2)
    const lines = next.split('\n')
    assert.equal(lines[lines.length - 2], '  disabled: true')
    assert.equal(lines[lines.length - 3], "  name: '@deepseek-ai/dsh-mcp-client'")
  })

  it('refuses a row with no keys of its own', () => {
    assert.throws(() => insertDisabled('- id: x', 4), /no keys at its own indentation/)
  })
})

describe('renderServerEntry', () => {
  it('puts the dash at the requested column and the keys two in', () => {
    const rendered = renderServerEntry({ serverName: 'a', transport: 'stdio', command: 'x' }, 6)
    assert.deepEqual(rendered.split('\n'), [
      '      - serverName: a',
      '        transport: stdio',
      '        command: x',
    ])
  })

  it('indents a nested sequence relative to the entry keys', () => {
    const rendered = renderServerEntry(
      { serverName: 'a', transport: 'stdio', command: 'x', args: ['-y', 'pkg'] },
      6,
    )
    assert.match(rendered, /\n {10}- '-y'\n {10}- pkg$/)
  })
})

describe('planAdoption — the move', () => {
  it('adopts the server and disables the row it came from', () => {
    const result = plan().plan
    assert.deepEqual(
      result.adoptions.map(adoption => adoption.entry['serverName']),
      ['codegraph'],
    )
    assert.deepEqual(result.disables.map(disable => disable.id), ['mcp-codegraph-managed'])
    assert.deepEqual(result.files.sort(), [HOME_FILE, PROFILE_FILE].sort())
    assert.equal(result.blocked, 0)
  })

  it('carries the server fields across, and drops the row identity', () => {
    const entry = plan().plan.adoptions[0]!.entry
    assert.deepEqual(entry, {
      serverName: 'codegraph',
      transport: 'stdio',
      command: 'codegraph',
      args: ['serve', '--mcp'],
      cwd: '/home/wings',
    })
  })

  it('writes serverName first, in schema order', () => {
    assert.deepEqual(Object.keys(plan().plan.adoptions[0]!.entry), [
      'serverName',
      'transport',
      'command',
      'args',
      'cwd',
    ])
  })

  it('drops a cwd that only means "unset"', () => {
    // The other plugin defaults cwd to '', which a subprocess reads as "unset"
    // and a human reader reads as a directory. Adopting the empty string would
    // move a meaningless field into the new config.
    const home = swapLine(HOME, 'cwd: /home/wings', "cwd: ''")
    assert.equal('cwd' in plan({ home }).plan.adoptions[0]!.entry, false)
  })
})

describe('planAdoption — what it refuses', () => {
  /** A row for a server this plugin does not implement. */
  const withUnsupported = (): string =>
    swapLine(ported(), 'cwd: /home/wings', ['cwd: /home/wings', 'reconnect:', '  maxAttempts: 3'])

  it('refuses a field it does not implement, and says which', () => {
    const result = planOne(withUnsupported())
    assert.equal(result.adoptions.length, 0)
    assert.equal(result.skips[0]!.reason, 'unsupported-field')
    assert.match(result.skips[0]!.detail!, /reconnect/)
    assert.equal(result.blocked, 1)
  })

  it('does not disable a row it refuses to move', () => {
    // Disabling first and failing to move second would leave the server in
    // neither plugin.
    const result = planOne(withUnsupported())
    assert.equal(result.disables.length, 0)
    assert.equal(result.edits.length, 0)
  })

  it('refuses a row containing a !!js expression', () => {
    const result = planOne(swapLine(ported(), 'command: codegraph', 'command: !!js pick()'))
    assert.equal(result.skips[0]!.reason, 'js-expression')
    assert.equal(result.blocked, 1)
  })

  it('refuses a row with no serverName without treating it as a failure', () => {
    // The other plugin requires serverName, so such a row never mounted and
    // never cost anything: nothing is left to do, so the exit code stays 0.
    const result = planOne(swapLine(ported(), 'serverName: codegraph', []))
    assert.equal(result.skips[0]!.reason, 'missing-server-name')
    assert.equal(result.blocked, 0)
    assert.equal(result.edits.length, 0)
  })

  it('refuses a duplicate serverName on both rows', () => {
    // Neither row can win: the other plugin refuses duplicate names too, so the
    // answer must not depend on which row is visited first.
    const home = [
      ported().trimEnd(),
      '- insert:',
      '    - id: second',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: codegraph',
      '        transport: stdio',
      '        command: other',
      '',
    ].join('\n')
    const first = findNativeRow(home, 'ported', HOME_FILE, 'home')!
    const second = findNativeRow(home, 'second', HOME_FILE, 'home')!
    const result = planAdoption({
      nativeRows: [second, first],
      existingServers: [],
      gatewayFile: PROFILE_FILE,
      read: () => home,
    })
    assert.equal(result.adoptions.length, 0)
    assert.deepEqual(result.skips.map(skip => skip.reason), ['duplicate-native', 'duplicate-native'])
    assert.equal(result.blocked, 2)
  })

  it('refuses a server this plugin could not load', () => {
    const result = planOne(swapLine(ported(), 'command: codegraph', []))
    assert.equal(result.skips[0]!.reason, 'cannot-work')
    assert.match(result.skips[0]!.detail!, /no command/)
    assert.equal(result.blocked, 1)
  })

  it('takes the server name from the config, not from the row id', () => {
    // The row's id names the loader row; `config.serverName` names the server.
    // They differ whenever somebody renamed one and not the other, and the
    // server's name is the one every other part of the config refers to.
    const result = planOne(swapLine(ported(), 'serverName: codegraph', 'serverName: actual-name'))
    assert.equal(result.adoptions[0]!.entry['serverName'], 'actual-name')
    assert.equal(result.blocked, 0)
  })

  it('leaves an already-disabled row alone and reports nothing to do', () => {
    const home = swapLine(ported(), "name: '@deepseek-ai/dsh-mcp-client'", [
      "name: '@deepseek-ai/dsh-mcp-client'",
      'disabled: true',
    ])
    const result = planOne(home)
    assert.equal(result.disables.length, 0)
    assert.equal(result.blocked, 0)
    assert.equal(result.skips[0]!.reason, 'already-lazy')
  })
})

describe('planAdoption — rows it cannot locate', () => {
  it('refuses a row the dump reports but no editable file declares', () => {
    // Dropping it silently is the one outcome this command exists to prevent:
    // the dump says the server is mounted and running, the plan says "nothing to
    // do", and the saving stays cancelled while the command reports success.
    const row = {
      id: 'from-overlay',
      serverName: 'overlay-server',
      raw: '',
      fields: { id: 'from-overlay', name: '@deepseek-ai/dsh-mcp-client' },
      layer: 'profile' as const,
      file: '/tmp/extra.yml',
      span: { start: 0, end: 0 },
      keyIndent: 0,
      disabled: false,
      jsExpression: false,
      origin: '/tmp/extra.yml',
    }
    const plan = planAdoption({
      nativeRows: [row],
      existingServers: [],
      gatewayFile: PROFILE_FILE,
      read: () => PROFILE,
    })
    assert.equal(plan.adoptions.length, 0)
    assert.equal(plan.disables.length, 0)
    assert.equal(plan.edits.length, 0)
    assert.equal(plan.skips[0]!.reason, 'unresolved')
    // A real skip, not a "nothing needed doing": the exit code says so.
    assert.equal(plan.blocked, 1)
    assert.match(plan.skips[0]!.detail!, /extra\.yml/)
  })

  it('resolves a row into whichever file declares it, not the last patcher', () => {
    // The dump attributes a patched row to the layer that patched it, which is
    // not necessarily the file holding the `- id:` line. Asking the files is what
    // makes the row findable, and the file that mounts the plugin is the one the
    // loader treats as the row.
    const box = sandbox()
    const rows = resolveNativeRows(box.composed.nativeRows, box.read, [PROFILE_FILE, HOME_FILE])
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.file, HOME_FILE)
    assert.equal(rows[0]!.origin, undefined)
  })
})

describe('planAdoption — idempotence', () => {
  it('does nothing on a second run over its own output', () => {
    // The property that makes `--write` twice in a row safe. The row is disabled
    // after the first run, and the server is in `servers` — so the plan for the
    // second run must be empty, not "disable it again".
    const first = plan()
    const newHome = rewritten(first.contents, first.plan, HOME_FILE)
    const newProfile = rewritten(first.contents, first.plan, PROFILE_FILE)
    assert.notEqual(newHome, HOME)
    assert.notEqual(newProfile, PROFILE)

    const second = plan({ home: newHome, profile: newProfile })
    assert.equal(second.plan.adoptions.length, 0)
    assert.equal(second.plan.disables.length, 0)
    assert.equal(second.plan.edits.length, 0)
    assert.equal(second.plan.blocked, 0)
  })

  it('still disables the row when the server is already in servers', () => {
    // The hole the design split in two: "already lazy" must skip the *adoption*
    // and still perform the *disable*, or the double registration survives.
    const result = plan({}, [
      { serverName: 'codegraph', transport: 'stdio', command: 'codegraph' },
    ]).plan
    assert.equal(result.adoptions.length, 0)
    assert.deepEqual(result.disables.map(disable => disable.id), ['mcp-codegraph-managed'])
    assert.equal(result.skips[0]!.reason, 'already-lazy')
    assert.equal(result.blocked, 0)
  })
})

describe('planAdoption — byte-level edits (I3, AD4)', () => {
  it('rewrites the file as the original with exactly those ranges replaced', () => {
    // The invariant, stated as arithmetic rather than as a promise: applying the
    // edit script to the original must give the new file, so every byte outside
    // the ranges is untouched by construction.
    const box = plan()
    for (const file of box.plan.files) {
      const original = box.contents.get(file)!
      const next = rewritten(box.contents, box.plan, file)
      const edits = box.plan.edits
        .filter(edit => edit.file === file)
        .sort((left, right) => left.start - right.start)
      let cursor = 0
      let reconstructed = ''
      for (const edit of edits) {
        reconstructed += original.slice(cursor, edit.start)
        reconstructed += edit.replacement
        cursor = edit.end
      }
      reconstructed += original.slice(cursor)
      assert.equal(next, reconstructed, file)
    }
  })

  it('changes exactly one line in the home layer', () => {
    const box = plan()
    const next = rewritten(box.contents, box.plan, HOME_FILE)
    const disables = box.plan.edits.filter(
      edit => edit.file === HOME_FILE && edit.kind === 'disable',
    )
    assert.equal(disables.length, 1)
    // Remove the inserted line: the file must be byte-identical to the original.
    assert.equal(next.replace(DISABLED_LINE, ''), HOME)
    assert.equal(next.length, HOME.length + DISABLED_LINE.length)
  })

  it('appends to the profile layer without rewriting a byte before it', () => {
    const box = plan()
    const next = rewritten(box.contents, box.plan, PROFILE_FILE)
    assert.equal(next.slice(0, PROFILE.length), PROFILE)
    // The entry is inserted at the end of the last server's last line, and the
    // newline that followed it stays where it was — so the file ends exactly as
    // it did, with no second blank line and no lost one.
    assert.equal(
      next.slice(PROFILE.length),
      '      - serverName: codegraph\n        transport: stdio\n        command: codegraph\n' +
        "        args:\n          - serve\n          - '--mcp'\n        cwd: /home/wings\n",
    )
  })

  it('keeps every comment and !!js expression in the profile layer', () => {
    const box = plan()
    const next = rewritten(box.contents, box.plan, PROFILE_FILE)
    assert.match(next, /# Hand-written notes belong to whoever wrote them/)
    assert.match(next, /idleTimeout: 10 {8}# inline comments too/)
    assert.match(next, /disabled: !!js "!process\.env\.CF_BROWSER_TOKEN"/)
    assert.match(next, /args: !!js "\['-y', 'chrome-devtools-mcp@latest'\]"/)
  })

  it('adopts into an empty servers list', () => {
    const profile = swapLine(PROFILE, 'servers:', 'servers: []')
    const box = plan({ profile })
    const next = rewritten(box.contents, box.plan, PROFILE_FILE)
    assert.match(next, /^ {4}servers:$/m)
    assert.match(next, /^ {6}- serverName: codegraph$/m)
    // The server that was already configured is still there.
    assert.match(next, /serverName: phonemcp/)
    assert.match(next, /# Hand-written notes belong/)
  })

  it('refuses to append when there is no gateway row to append to', () => {
    const box = sandbox()
    const rows = resolveNativeRows(box.composed.nativeRows, box.read)
    assert.throws(
      () => planAdoption({ nativeRows: rows, existingServers: [], read: box.read }),
      /no "mcp-lazy" row to move them into/,
    )
  })

  it('throws rather than producing a plausible wrong file when edits overlap', () => {
    assert.throws(
      () =>
        applyEdits('abcdef', [
          { start: 2, end: 4, replacement: 'X' },
          { start: 1, end: 3, replacement: 'Y' },
        ]),
      /overlap/,
    )
  })
})

describe('summarizePlan', () => {
  it('names every decision so a dry run is readable', () => {
    const text = summarizePlan(plan().plan)
    assert.match(text, /1 server\(s\) to move/)
    assert.match(text, /adopt {3}codegraph/)
    assert.match(text, /disable mcp-codegraph-managed/)
  })
})

describe('splitSource', () => {
  it('records offsets that address the original text', () => {
    const text = 'one\ntwo\r\nthree'
    for (const line of splitSource(text)) {
      assert.equal(text.slice(line.start, line.start + line.text.length), line.text)
    }
  })
})

describe('serverEntryFrom', () => {
  it('keeps a field the order list does not know about', () => {
    // Dropping a field silently is the exact failure this command exists to fix,
    // so an unrecognised-but-supported field moves across rather than vanishing.
    const row = findNativeRow(HOME, 'mcp-codegraph-managed', HOME_FILE, 'home')!
    row.fields['debug'] = true
    assert.equal(serverEntryFrom(row)['debug'], true)
  })
})
