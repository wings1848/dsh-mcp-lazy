/**
 * Read what the loader would actually mount, from `dsh --dump-config`.
 *
 * A patch file is an operation list, not a configuration: the same entry can be
 * patched by a later layer, an `insert` list is flattened into its parent, and a
 * patch whose `id` does not exist yet is skipped with a warning rather than an
 * error. A reader that only scanned one patch file therefore cannot answer "what
 * is configured right now" — and that question is exactly what the adopt
 * command's idempotence depends on.
 *
 * So the composed tree comes from the same code path the boot uses
 * (`applyEntryPatches` via `--dump-config`), and this module only does the two
 * things that output still needs: attach the layer each row came from, and keep
 * a byte-exact reference back into the file the row was written in, because the
 * write path is a text rewrite rather than a re-serialisation.
 *
 * The dump does not evaluate `!!js` expressions, so nothing here can either.
 *
 * @module dsh-mcp-lazy/adopt-compose
 */

import yaml from 'js-yaml'

/** The plugin whose rows this command moves servers out of. */
export const NATIVE_MCP_PLUGIN = '@deepseek-ai/dsh-mcp-client'

/** This plugin's own loader id, whose `servers` list adopted rows go into. */
export const LAZY_PLUGIN = 'mcp-lazy'

/**
 * This plugin's npm package name, as a profile's `dsh.profile.bundles` lists it.
 *
 * Distinct from {@link LAZY_PLUGIN}: the loader id names the row, the package
 * name names the dependency. Answering "does this profile even mount the
 * gateway?" means asking about the package, and using the row id for it would
 * silently answer "no" for every profile.
 */
export const LAZY_PACKAGE = 'dsh-mcp-lazy'

/** The marker `dsh --dump-config` uses to name the layers that patched a row. */
const PATCHED_BY = ', patched by '

/**
 * The `!!js` scalar type, as the loader's dialect defines it.
 *
 * Same tag, same predicate and same representer as
 * `@deepseek-ai/dsh-app-boot`'s entry-list schema, so a value that survives here
 * would survive a boot. `adopt` never evaluates these — it refuses to rewrite a
 * row that contains one — but parsing must still succeed, and a round trip must
 * not turn the expression into a string.
 */
export const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: data => typeof data === 'string',
  construct: data => ({ __jsExpr: data }),
  predicate: (value: unknown): boolean =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { __jsExpr?: unknown }).__jsExpr === 'string',
  represent: (value: unknown) => String((value as { __jsExpr: string }).__jsExpr),
})

/** The YAML dialect the loader reads: `JSON_SCHEMA` plus `!!js`. */
export const ENTRY_SCHEMA = yaml.JSON_SCHEMA.extend([JsExpr])

/** A node in the composed dump, in the shapes this command cares about. */
interface DumpNode {
  id?: unknown
  name?: unknown
  disabled?: unknown
  insert?: unknown
  config?: unknown
  group?: unknown
}

/** One row of the composed tree, with the file it can be rewritten in. */
export interface ComposedRow {
  /** The file this row's `- insert:` list is written in, if it is known. */
  file?: string
  /** Whether that file is the home layer or the profile layer. */
  layer: 'home' | 'profile' | 'unknown'
  /** The raw entry, exactly as the dump printed it. */
  entry: DumpNode
}

/** One entry of the composed tree under `id: mcp-lazy`. */
export interface ComposedGateway {
  /** The file carrying the `id: mcp-lazy` row. */
  file?: string
  /** The layer that file belongs to. */
  layer: 'home' | 'profile' | 'unknown'
  /** The `servers` list found in the composed config, or an empty list. */
  servers: Record<string, unknown>[]
}

/** What `parseComposedDump` returns. */
export interface ComposedDump {
  /** Every `@deepseek-ai/dsh-mcp-client` row in the composed tree. */
  nativeRows: ComposedRow[]
  /** The composed `mcp-lazy` entry, when one is declared. */
  gateway?: ComposedGateway
  /** The `dsh-mcp-client` rows contributed by `--patch` overlays. */
  overlays: ComposedRow[]
  /** The file each layer's rows were attributed to, in application order. */
  labels: string[]
}

/**
 * Work out which layer a dump label names.
 *
 * Labels are absolute paths in the dump. `$DSH_HOME/cordis.patch.yml` is the
 * home layer; anything under `$DSH_HOME/profiles/<name>/` is the profile layer;
 * a `--patch` overlay is neither. The distinction is load-bearing — a patch
 * written into the wrong layer is skipped silently (the target id does not exist
 * yet at that point in the order) and still exits 0 — so it is derived from the
 * path rather than assumed.
 *
 * @param label - A layer label from the dump.
 * @param dshHome - The resolved `$DSH_HOME`.
 * @param profileDir - The resolved profile directory.
 * @returns The layer kind.
 */
export function classifyLayer(
  label: string,
  dshHome: string,
  profileDir: string,
): 'home' | 'profile' | 'unknown' {
  const normalized = label.replace(/\\/g, '/')
  const home = `${dshHome.replace(/\\/g, '/').replace(/\/$/, '')}/cordis.patch.yml`
  if (normalized === home) return 'home'
  if (normalized.startsWith(`${profileDir.replace(/\\/g, '/').replace(/\/$/, '')}/`)) {
    return 'profile'
  }
  return 'unknown'
}

/**
 * Split a config dump into its layers and parse each one.
 *
 * The dump is a YAML document per layer, each preceded by a `# == <label>`
 * comment naming where the rows in that run came from. Rows are re-emitted from
 * the composed tree, not copied from the source files, so the label is the only
 * provenance available and the only link back to a file that can be edited.
 *
 * @param text - The full `dsh --dump-config` output.
 * @param dshHome - The resolved `$DSH_HOME`.
 * @param profileDir - The resolved profile directory.
 * @returns The rows, the composed gateway entry, and the labels seen.
 */
export function parseComposedDump(text: string, dshHome: string, profileDir: string): ComposedDump {
  const nativeRows: ComposedRow[] = []
  const overlays: ComposedRow[] = []
  const labels: string[] = []
  let gateway: ComposedGateway | undefined

  let label: string | undefined
  let buffer: string[] = []

  /** Parse one buffered layer and file its rows. */
  const flush = (): void => {
    const body = buffer.join('\n')
    buffer = []
    if (label === undefined) return
    const layer = classifyLayer(label, dshHome, profileDir)
    labels.push(label)
    let parsed: unknown
    try {
      parsed = yaml.load(body, { schema: ENTRY_SCHEMA })
    } catch {
      // A layer this command does not understand is not an error: it simply
      // contributes no rows. Refusing to run because some unrelated plugin's
      // patch is exotic would make the command useless on any real machine.
      return
    }
    if (!Array.isArray(parsed)) return
    for (const node of parsed as DumpNode[]) walkNode(node, label, layer)
  }

  /**
   * Record one composed node, recursing into groups and `insert` lists.
   *
   * @param node - A node from the composed tree.
   * @param label - The file label the node came from.
   * @param layer - The layer that file belongs to.
   */
  const walkNode = (
    node: DumpNode,
    label: string,
    layer: 'home' | 'profile' | 'unknown',
  ): void => {
    if (typeof node !== 'object' || node === null) return
    if (node.name === NATIVE_MCP_PLUGIN) {
      const row: ComposedRow = { file: label, layer, entry: node }
      if (layer === 'unknown') overlays.push(row)
      else nativeRows.push(row)
    }
    if (node.id === LAZY_PLUGIN && gateway === undefined) {
      const config = (node.config ?? {}) as { servers?: unknown }
      gateway = {
        file: label,
        layer,
        servers: Array.isArray(config.servers)
          ? (config.servers as Record<string, unknown>[])
          : [],
      }
    }
    if (Array.isArray(node.insert)) {
      for (const child of node.insert as DumpNode[]) walkNode(child, label, layer)
    }
    // A group's entries live in `config` as a list. The loader flattens inserts
    // into their parent; groups are the other place rows can hide.
    if (Array.isArray(node.config)) {
      for (const child of node.config as DumpNode[]) walkNode(child, label, layer)
    }
  }

  for (const line of text.split('\n')) {
    const marker = /^# == (.*)$/.exec(line)
    if (marker !== null) {
      flush()
      label = fileOfMarker(marker[1] ?? '')
      continue
    }
    if (label !== undefined) buffer.push(line)
  }
  flush()

  return {
    nativeRows,
    ...(gateway === undefined ? {} : { gateway }),
    overlays,
    labels,
  }
}

/**
 * Reduce a dump marker to the file its rows can be written back to.
 *
 * A marker is `origin`, optionally suffixed with `, patched by <layer>` once for
 * every layer that changed the row. The origin is the *base* file the entry was
 * declared in, which is not where it was patched: an `insert` from a patch layer
 * lands in the base file's tree, so the row appears under
 * `# == dsh-mcp-lazy, patched by /path/profile/cordis.patch.yml`. The last
 * `patched by` layer is the one that made the most recent change, and therefore
 * the file a rewrite has to edit.
 *
 * A layer label that is itself a list — the dump joins them with `, ` — is cut
 * at the next comma, since a file path is what this returns.
 *
 * @param marker - The text after `# == ` in the dump.
 * @returns The absolute path of the file to edit, or the origin when the marker
 * names no patch layer (the row is untouched and lives in its origin).
 */
export function fileOfMarker(marker: string): string {
  const at = marker.lastIndexOf(PATCHED_BY)
  if (at === -1) return marker.trim()
  const after = marker.slice(at + PATCHED_BY.length)
  return (after.split(',')[0] ?? after).trim()
}
