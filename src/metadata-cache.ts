/**
 * Persistent metadata cache.
 *
 * This file is what lets `mcp({ search })` and `mcp({ describe })` answer
 * **without spawning or connecting to anything** — the property the whole
 * plugin exists for. A server's tool catalog is written here whenever it is
 * fetched live, and read back on the next start.
 *
 * An entry is valid only while its `configHash` matches the current entry: change
 * the command, args, env, url, or headers and the cached catalog is stale by
 * definition. Age is a second, independent bound.
 *
 * @module dsh-mcp-lazy/metadata-cache
 */

import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_CACHE_MAX_AGE_MS } from './schema.js'
import type { MetadataCache, ServerCacheEntry, ServerEntry, ToolMetadata } from './types.js'

/** Bump when the on-disk shape changes; older files are ignored, not migrated. */
export const CACHE_VERSION = 1

/** Directory (inside the DSH home) that holds this plugin's cache. */
const CACHE_DIR_NAME = 'mcp-lazy'

/** File name inside {@link CACHE_DIR_NAME}. */
const CACHE_FILE_NAME = 'cache.json'

/**
 * Permissions for the cache directory and the cache file.
 *
 * The cache holds no credentials, but it does hold the name and description of
 * every tool the configured servers expose — a readable inventory of what the
 * user has installed and can reach. Nothing outside this account has a reason
 * to read it, so it is written the way the rest of the plugin's files are rather
 * than with whatever umask happens to be in force.
 */
const CACHE_DIR_MODE = 0o700
const CACHE_FILE_MODE = 0o600

/**
 * Resolve the DSH home directory.
 *
 * `$DSH_HOME` wins; otherwise `~/.dsh`, matching the harness default.
 *
 * @returns Absolute path of the DSH home directory.
 */
export function resolveDshHome(): string {
  const fromEnv = process.env['DSH_HOME']
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * Absolute path of the metadata cache file.
 *
 * @returns The cache path.
 */
export function metadataCachePath(): string {
  return join(resolveDshHome(), 'storages', CACHE_DIR_NAME, CACHE_FILE_NAME)
}

/**
 * Whether one `servers` member of a parsed cache is safe to hand out.
 *
 * This is the check that keeps a bad file from becoming a failed plugin load.
 * The cache is written by other builds, edited by hand, and left behind by
 * crashes, so "it parsed" is not the same as "it can be dereferenced" — every
 * field read downstream is checked here instead.
 *
 * The test is about shape only. Whether the catalog still describes the
 * configured server is a different question, answered by the hash comparison in
 * {@link isCacheEntryValid}.
 *
 * A malformed tool list invalidates the whole entry rather than being filtered:
 * an entry that survived as an empty catalog would make the registry treat the
 * server as already known, and discovery only connects servers it has no
 * catalog for — so a partly bad list would leave the server permanently
 * unreachable from search.
 *
 * @param value - One value from the parsed `servers` object.
 * @returns Whether the entry may be loaded.
 */
function isServerCacheEntry(value: unknown): value is ServerCacheEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<ServerCacheEntry>
  if (typeof entry.configHash !== 'string') return false
  if (typeof entry.cachedAt !== 'number' || !Number.isFinite(entry.cachedAt)) return false
  if (!Array.isArray(entry.tools)) return false
  if (entry.instructions !== undefined && typeof entry.instructions !== 'string') return false
  return entry.tools.every(
    item =>
      typeof item === 'object'
      && item !== null
      && typeof (item as Partial<ToolMetadata>).originalName === 'string',
  )
}

/**
 * Read the cache from disk.
 *
 * Every failure path returns `null` rather than throwing: a corrupt or
 * unreadable cache must degrade to "search is empty until something connects",
 * never to a failed plugin load.
 *
 * A single unusable entry is dropped on its own instead of voiding the file:
 * one server's stale catalog is no reason to re-fetch every other server's, and
 * the registry reads this object during construction, where an exception is the
 * plugin load itself.
 *
 * @returns The parsed cache, or `null` when absent, unreadable, or malformed.
 */
export function loadMetadataCache(): MetadataCache | null {
  const path = metadataCachePath()
  if (!existsSync(path)) return null
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof raw !== 'object' || raw === null) return null
    const candidate = raw as Partial<MetadataCache>
    if (candidate.version !== CACHE_VERSION) return null
    if (typeof candidate.servers !== 'object' || candidate.servers === null) return null
    const servers: Record<string, ServerCacheEntry> = {}
    for (const [name, entry] of Object.entries(candidate.servers)) {
      if (isServerCacheEntry(entry)) servers[name] = entry
    }
    return { version: CACHE_VERSION, servers }
  } catch {
    return null
  }
}

/**
 * Write the cache to disk atomically.
 *
 * Writes a sibling temporary file and renames it over the target so a crash
 * mid-write cannot leave a truncated cache behind.
 *
 * @param cache - The cache to persist.
 */
export function saveMetadataCache(cache: MetadataCache): void {
  const path = metadataCachePath()
  const directory = dirname(path)
  try {
    mkdirSync(directory, { recursive: true, mode: CACHE_DIR_MODE })
    // `mkdirSync` applies its mode only to a directory it creates, and this
    // directory outlives any single release: without this, an installation that
    // has been running an older build would keep 0755 forever. Best-effort
    // because not every filesystem carries POSIX modes, and a mode that cannot
    // be set must not cost the write itself.
    try {
      chmodSync(directory, CACHE_DIR_MODE)
    } catch {
      // See above.
    }
    const temp = `${path}.${process.pid}.tmp`
    // For the same reason as the chmod above: `writeFileSync` applies its mode
    // only to a file it creates, so a temp file left behind by a crashed
    // process would carry its old permissions through the rename.
    rmSync(temp, { force: true })
    writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`, {
      encoding: 'utf8',
      mode: CACHE_FILE_MODE,
    })
    renameSync(temp, path)
  } catch {
    // A cache that cannot be written is a performance loss, not a failure:
    // the next live fetch still answers correctly.
  }
}

/**
 * Canonical JSON with object keys sorted, so a hash does not depend on the
 * order a caller happened to write fields in.
 *
 * @param value - Any lossless JSON value.
 * @returns A deterministic string form.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

/**
 * Hash the transport-relevant part of a server entry.
 *
 * Deliberately excludes presentation and lifecycle fields (`idleTimeout`,
 * `directTools`, `includeTools`, `excludeTools`, `searchKeywords`, `disabled`):
 * changing how tools are *presented* must not throw away a perfectly good
 * catalog, while changing how the server is *reached* must.
 *
 * This exclusion is only sound because the cached catalog holds the server's
 * **full** tool list and `includeTools`/`excludeTools` are applied when the
 * cache is read. If a filtered list were ever stored, dropping a field from
 * this hash would turn a filter into a permanent, uninvalidateable deletion.
 *
 * @param entry - The configured server entry.
 * @returns A stable hex digest.
 */
export function computeConfigHash(entry: ServerEntry): string {
  const transportPart = {
    transport: entry.transport,
    command: entry.command ?? null,
    args: entry.args ?? [],
    env: entry.env ?? {},
    cwd: entry.cwd ?? null,
    url: entry.url ?? null,
    headers: entry.headers ?? {},
  }
  return createHash('sha256').update(canonicalJson(transportPart)).digest('hex')
}

/**
 * Whether a cached entry still describes the configured server.
 *
 * @param cached - The cached entry, when one exists.
 * @param entry - The current configuration.
 * @param maxAgeMs - Age bound; defaults to seven days.
 * @param now - Current epoch milliseconds, injectable for tests.
 * @returns Whether the cached catalog may be trusted.
 */
export function isCacheEntryValid(
  cached: ServerCacheEntry | undefined,
  entry: ServerEntry,
  maxAgeMs: number = DEFAULT_CACHE_MAX_AGE_MS,
  now: number = Date.now(),
): cached is ServerCacheEntry {
  if (cached === undefined) return false
  if (cached.configHash !== computeConfigHash(entry)) return false
  if (typeof cached.cachedAt !== 'number' || !Number.isFinite(cached.cachedAt)) return false
  return now - cached.cachedAt <= maxAgeMs
}

/**
 * Build a fresh cache entry from a live fetch.
 *
 * @param entry - The server the tools came from.
 * @param tools - The server's full tool list with names applied. Must NOT be
 *   `includeTools`/`excludeTools`-filtered: read-side filtering is what keeps a
 *   filter change from becoming a permanent deletion.
 * @param instructions - The server's own instructions, when published.
 * @param now - Current epoch milliseconds.
 * @returns The entry to store.
 */
export function buildCacheEntry(
  entry: ServerEntry,
  tools: ToolMetadata[],
  instructions: string | undefined,
  now: number = Date.now(),
): ServerCacheEntry {
  const built: ServerCacheEntry = {
    configHash: computeConfigHash(entry),
    cachedAt: now,
    tools,
  }
  if (instructions !== undefined && instructions !== '') built.instructions = instructions
  return built
}
