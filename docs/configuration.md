# Configuration

`dsh-mcp-lazy` registers one model-facing tool, `mcp` (`src/schema.ts`), and owns every
server in this row's `servers` list. Applying the plugin contacts no server and spawns no
child process for the default `lazy` mode (`src/index.ts`); it does read the metadata cache
from disk, and a server configured `eager` or `keep-alive` is connected during activation
(`src/registry.ts`).

## Profile entry

Add the row to a profile's patch layer (`~/.dsh/profiles/<name>/cordis.patch.yml`), a
top-level YAML array of loader patch entries; `id` is the row the patch layer targets.

```yaml
- insert:
    - id: mcp-lazy
      name: 'dsh-mcp-lazy'
      config:
        idleTimeout: 10            # minutes; 0 disables idle reaping
        freezeDirectTools: false   # stop promoting after the first sync pass
        outputGuard: { maxBytes: 51200, maxLines: 2000 }
        servers:
          - serverName: chrome
            transport: stdio
            command: npx
            args: ['-y', 'chrome-devtools-mcp@1.6.0']
            env: { CHROME_HEADLESS: '1' }
            lifecycle: lazy
            idleTimeout: 5
          - serverName: docs
            transport: streamable-http
            url: http://127.0.0.1:3000/mcp
            headers: { Authorization: 'Bearer <token>' }
            directTools: search
            includeTools: ['search_*', 'get_*']
            excludeTools: ['*_draft']
```

## Plugin-level fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `idleTimeout` | integer ≥ 0 | `10` | Idle-reap window in minutes for `lazy` servers that do not set their own; every other lifecycle defaults to `0`. `0` never reaps (`src/index.ts`, `src/schema.ts`, `src/registry.ts`). |
| `freezeDirectTools` | boolean | `false` | Stop accepting new `directTools` promotions after the first sync pass (`src/index.ts`, `src/direct-tools.ts`). |
| `directTools` | `true` \| `false` \| `'search'` | `false` | Promotion default for every server; a server's own `directTools` wins. See below (`src/index.ts`, `src/registry.ts`). |
| `outputGuard` | `true` \| `false` \| `{ enabled, maxBytes, maxLines }` | `true` | Bound server-authored output; `true` applies the built-in ceilings, `false` returns oversized output verbatim (`src/index.ts`, `src/output-guard.ts`). |
| `servers` | array of server entries | `[]` | The server list; an empty list is legal and means there is nothing to route to (`src/index.ts`). |

## Per-server fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `serverName` | string | required | Namespace for this server; must match `^[A-Za-z0-9_-]{1,32}$` and be unique in the list (`src/index.ts`, `src/types.ts`). |
| `transport` | `stdio` \| `streamable-http` | required | How the server is reached (`src/index.ts`). |
| `command` | string | — | stdio only: executable to spawn. Required for `stdio` (`src/index.ts`, `src/connection.ts`). |
| `args` | string[] | `[]` | stdio only: arguments passed to the child verbatim, with no shell interpolation (`src/index.ts`, `src/types.ts`). |
| `env` | map of string → string | `{}` | stdio only: merged over the scrubbed ambient environment; explicit values win (`src/connection.ts`). |
| `cwd` | string | — | stdio only: working directory for the child; an empty string is ignored (`src/connection.ts`). |
| `url` | string | — | `streamable-http` only: the MCP endpoint. Required for `streamable-http` (`src/index.ts`, `src/connection.ts`). |
| `headers` | map of string → string | `{}` | `streamable-http` only: extra request headers; omitted entirely when empty (`src/connection.ts`). |
| `toolCallTimeoutMs` | number | `60000` | Per-`tools/call` timeout in milliseconds. `0` passes no timeout at all (`src/connection.ts`, `src/schema.ts`). |
| `lifecycle` | `lazy` \| `lazy-keep-alive` \| `eager` \| `keep-alive` | `lazy` | Selects when the process starts and the default idle window; see below (`src/index.ts`, `src/registry.ts`). |
| `idleTimeout` | integer ≥ 0 | inherits | This server's reap window in minutes; overrides the plugin-level value, `0` included (`src/registry.ts`). |
| `directTools` | `true` \| string[] \| `'search'` | not promoted | Promote tools out of the proxy into native tools (`src/index.ts`, `src/direct-tools.ts`). |
| `includeTools` / `excludeTools` | string[] | — | Keep only / drop tools matching these names or globs; include is checked first, exclude wins (`src/naming.ts`). |
| `searchKeywords` | map of string → string[] | — | Extra ranking keywords per tool, keyed by name or glob (`src/naming.ts`). |
| `disabled` | boolean | `false` | Keep the entry visible in status but refuse to connect or call (`src/registry.ts`). |
| `debug` | boolean | `false` | Forward the stdio child's stderr to the host instead of capturing it (`src/connection.ts`). |

A duplicate `serverName`, a `stdio` entry with no `command`, and a `streamable-http` entry
with no `url` throw at load (`src/index.ts`).

## Transports

`stdio` spawns a child from `command` and `args`, with `cwd` when set, and an environment of
scrubbed ambient names — `KEY|PASSWORD|SECRET|TOKEN` and every `DSH_*` name are dropped
(`scrubbedParentEnv`, `@deepseek-ai/dsh-subprocess`, used in `src/connection.ts`) — plus the
entry's own `env`, so an explicit value wins. `streamable-http` connects to `url`, sending
`headers` when any are set (`src/connection.ts`).

## Lifecycle and idle reaping

`lifecycle` accepts four values. Two things depend on it: which default idle window
`resolveServer` picks, and whether the server is contacted while the plugin is applied
(`src/index.ts`, `src/registry.ts`).

| `lifecycle` | When the process starts | Default idle window |
|---|---|---|
| `lazy` (default) | first use | plugin `idleTimeout` (10 minutes) |
| `lazy-keep-alive` | first use | `0` — never reaped |
| `eager` | plugin activation | `0` — never reaped |
| `keep-alive` | plugin activation | `0` — never reaped |

An explicit `idleTimeout` always wins, `0` included, and only `lazy` inherits the global
window: every other mode means "keep this process", so its window defaults to zero
(`src/registry.ts`).

**Activation connects only what asked for it.** `apply()` consults
`registry.residentServers()`, which selects `eager` and `keep-alive` and skips anything
`disabled`. Those connects are fire-and-forget, after the proxy tool is registered, so a slow
server cannot delay the model-facing tool surface or fail plugin load; a failure is recorded
for the retry backoff and reported in status instead. A default configuration is entirely
`lazy`, so that list is empty and applying the plugin still spawns nothing — the property the
plugin exists for (`src/index.ts`, `src/registry.ts`). `eager` and `keep-alive` behave
identically here; both names exist because `pi-mcp-adapter` defines both and configurations
carried over from it must keep working (`src/types.ts`).

A sweep runs every 30 seconds (`IDLE_SWEEP_INTERVAL_MS`, `src/connection.ts`), unref'd so it
never holds the host open. A connection is closed when its window is greater than zero, no
call is in flight, and the last use was more than the window ago (`sweepIdle`,
`src/connection.ts`).

## `directTools` promotion

Promotion is the one switch that moves the model-visible tool surface, so it is opt-in per
server (`src/direct-tools.ts`).

| Value | Effect |
|---|---|
| omitted / `false` | Proxy only. The model-facing surface stays exactly one tool. |
| `true` | Every filtered tool of this server is registered as a native tool. |
| `string[]` | Only matching tools are registered. Patterns are globs (`*`) matched case-insensitively against the tool's own name, the qualified name, and the tail after `__` (`src/naming.ts`, `src/registry.ts`). |
| `'search'` | Tools are staged, not registered. `mcp({ search })` activates the ones it matches, and the search result names them (`src/direct-tools.ts`, `src/proxy-tool.ts`). |

There is also a **plugin-level default** that applies to every server:

```yaml
- id: mcp-lazy
  config:
    directTools: true      # or 'search'; default false
    servers: []
```

A server's own `directTools` wins over it, including `false` — that is how one server opts out
of a plugin-wide `true`. This mirrors `settings.directTools` in `pi-mcp-adapter`, and it exists
so that "expose everything natively" does not mean editing every server row. The list form
stays per-server, because a list of names has no meaning across servers that do not share a
catalog (`src/index.ts`, `src/registry.ts`).

**Promotion needs a known catalog.** On a cold cache there is nothing to promote yet, so
`directTools` registers nothing until the server has connected once and its tool list is
cached. That is the same trade the rest of the plugin makes; it is worth knowing before
concluding that the setting did not work.

Setting `directTools: true` everywhere is what `@deepseek-ai/dsh-mcp-client` does
unconditionally, which removes the reason this plugin exists. It is here for the servers where
a native tool is genuinely worth moving the prefix, not as a default worth reaching for.

**The consequence:** a promoted tool is a real tool in the request, so the tool-definition
prefix changes and the prompt cache is invalidated from the first changed token
(`src/schema.ts`, `src/index.ts`). `'search'` defers that change until the model goes looking
for a tool; `freezeDirectTools: true` bounds the churn to one event (`src/direct-tools.ts`).

**Timing.** Promotion is evaluated at activation, after a live catalog refresh (a server's
`notifications/tools/list_changed`), and for `'search'` servers after each `mcp({ search })`
(`src/index.ts`, `src/registry.ts`). With nothing cached at activation, `true` and `string[]`
have no catalog to promote from; with `freezeDirectTools: true`, that first empty pass freezes
promotion for the session (`src/direct-tools.ts`).

## Tool filtering

`includeTools` is checked first; `excludeTools` is checked after and wins (`src/naming.ts`).
Both take a tool name or a `*` glob, matched case-insensitively against three spellings of the
same tool: the tool's own name, the qualified name (`serverName__tool`), and the part after
the `serverName__` prefix — so `read_*`, `srv__read_*`, and `read_file` all address the same
tool (`src/naming.ts`). Filtering is applied **when a catalog is read**, live or from cache
(`src/registry.ts`), so loosening a filter takes effect immediately.

The disk cache always stores the server's full tool list, and its config hash covers only the
transport-relevant fields — `transport`, `command`, `args`, `env`, `cwd`, `url`, `headers`.
Everything else is outside it, among them `includeTools`, `excludeTools`, `searchKeywords`,
`directTools`, `idleTimeout`, `lifecycle`, `disabled`, `debug`, `toolCallTimeoutMs`
(`src/metadata-cache.ts`).

`searchKeywords` maps a tool name or glob to extra words, and every matching key contributes.
Keywords affect only `mcp({ search })` ranking: they never reach a schema, a description, or
the cache (`src/types.ts`, `src/naming.ts`, `src/search-ranking.ts`).

## Output guard

Server-authored output is bounded before it reaches the model: the head is kept and the full
text is spilled to a temp file whose path is handed back (`src/output-guard.ts`).

| Setting | Default | Meaning |
|---|---|---|
| `outputGuard` | `true` | `true` uses the ceilings below, `false` returns oversized output verbatim, and an object tunes them (`src/index.ts`, `src/output-guard.ts`). |
| `maxBytes` | `51200` (50 KiB) | Inline byte ceiling. |
| `maxLines` | `2000` | Inline line ceiling; `enabled: false` inside the object form turns truncation off. |

Truncation happens when either ceiling is exceeded. Lines are cut before bytes, so the
reported line count is never thrown off by a partial line, and the cut never splits a UTF-8
sequence (`src/output-guard.ts`). The text ends with a notice like:

```
[MCP output truncated: original 41233 lines / 3.1 MiB. showing the first 2000 lines. Full text saved to: /tmp/dsh-mcp-lazy-output-XXXXXX/output-ab12cd34.txt — read it with offset/limit, or grep it.]
```

The spill file is created with `mkdtemp` under the system temp directory, as
`dsh-mcp-lazy-output-<random>/output-<hex>.txt`, written with mode `0600`, and capped at
16 MiB (`MAX_SPILL_BYTES`) — past that it holds the head plus a marker saying so
(`src/output-guard.ts`). Directories the guard created are removed when the plugin is disposed
(`OutputGuard.dispose`, `src/index.ts`); crash leftovers stay in the temp directory.

Guarded are the payloads a server wrote: a tool result, a `describe` schema, a server's
instructions, and the results of promoted native tools (`src/proxy-tool.ts`,
`src/direct-tools.ts`). Status, search, and error text is rendered by the gateway and does not
pass through the guard — `mcp({ search })` quotes a tool's description verbatim, so an
enormous description still produces a large search result (`src/proxy-tool.ts`).

## Migrating from `@deepseek-ai/dsh-mcp-client`

Each `dsh-mcp-client` row becomes one entry under this plugin's `servers` list, and the
per-row `id` goes away. The transport fields keep their meaning (`src/types.ts`,
`cordis.patch.yml`): `serverName`, `transport`, `command`, `args`, `env`, `cwd`, `url`,
`headers`, `toolCallTimeoutMs`.

Two of that plugin's fields are **not** implemented here — `reconnect` and
`failOnStartupError` — and carrying them over is an error rather than a no-op, so that a
setting cannot sit in the configuration looking applied while nothing reads it.

**Running both plugins is not an error, and that is the problem.** Nothing clashes: this
plugin's tool is `mcp` and the other's are `mcp__<server>__<tool>`, so both load, both work,
and the schemas this plugin exists to remove are sent anyway. Because there is no symptom,
`mcp({})` names the servers it found configured on the other plugin and asks the model to
pass that on. Disable the other plugin's rows, or move them here, to get the saving back.

```yaml
# before: one row per server
- id: mcp-github
  name: '@deepseek-ai/dsh-mcp-client'
  config: { serverName: github, transport: stdio, command: npx, args: ['-y', '@modelcontextprotocol/server-github'] }

# after: one row; that config becomes one `servers` entry, minus the row's `id`
- id: mcp-lazy
  name: 'dsh-mcp-lazy'
  config:
    servers:
      - { serverName: github, transport: stdio, command: npx, args: ['-y', '@modelcontextprotocol/server-github'] }
```

Calls now go through one tool, `mcp({ tool, args })`, and a promoted tool is named
`serverName__originalName` (`src/naming.ts`). `serverName` need only be unique inside this
plugin's own list (`src/index.ts`).
