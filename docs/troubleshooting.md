# Troubleshooting

The gateway's own diagnostics are the place to start. `mcp({})` prints one line per
configured server with its lifecycle, connection state, tool count and known failure, plus
the path of the metadata cache (rendered in `src/proxy-tool.ts`). From there:

- `mcp({ connect: "name" })` — start one server now, refresh its cached metadata, and
  ignore the failure backoff (`src/proxy-tool.ts`).
- `mcp({ search: "keyword" })` — what is known offline, without starting anything
  (`src/registry.ts`).
- `mcp({ instructions: "name" })` — the server's own usage notes, when it published any
  (`src/registry.ts`).

## A server failed to start

A start failure is anything that makes the connect attempt throw: a wrong command, a
missing dependency, a protocol error, a refused URL. The registry records the time and the
message, and then leaves that server alone for 60 seconds (`FAILURE_BACKOFF_MS`,
`src/registry.ts`).

The window exists because a tool call is what starts a server: without it, one broken server
would be re-spawned and re-timed-out on every call that mentions one of its tools, and the
same failure would be rediscovered each time (`src/registry.ts`).

Status shows the suppression explicitly (`src/proxy-tool.ts`):

```
  broken — 0 tools (lazy, failed, retry suppressed, failed 0s ago, no metadata yet)
      last error: MCP error -32000: Connection closed (stderr: fixture: configured to fail before serving)
```

Inside the window, an automatic attempt is refused with the remaining time
(`#backoffReason`, `src/registry.ts`):

```
mcp-lazy: server "broken" failed 1s ago and is not retried automatically for another 60s: <detail>
```

Where the model sees that depends on the path. Cold-start discovery reports it as a server
that could not start and keeps looking on the others (`src/registry.ts`,
`src/proxy-tool.ts`):

```
No known MCP tool named "echo". Use mcp({ search: "<keyword>" }) to find the exact name.
Servers that could not start: broken: mcp-lazy: server "broken" failed 1s ago and is not retried automatically for another 60s: <detail>
```

When the tool name already resolves from a known catalog, the call itself fails:
`Calling "broken__echo" on server "broken" failed: mcp-lazy: server "broken" failed …`
(`src/proxy-tool.ts`).

**Fixing it now.** An explicit `mcp({ connect: "broken" })` bypasses the backoff. It is
forced, so a server whose command was just corrected is retried immediately instead of
waiting out the window (`src/registry.ts`, `src/proxy-tool.ts`). After the window expires,
the next automatic attempt is allowed too; a successful connect clears both the error and
the failure timestamp (`src/registry.ts`).

The window is not configurable. `failureBackoffMs` exists in the resolved config type only
so a test can pin it; there is no user-facing spelling (`src/types.ts`).

## Where the stdio child's stderr goes

By default it is piped and captured, because the SDK's own default (`inherit`) hands the
stream to the host and leaves `transport.stderr` null — with no capture, a startup failure
has no explanation at all (`src/connection.ts`).

The capture is a bounded tail: the last 8192 characters are kept (`MAX_STDERR_CHARS`) and
the error quotes the last three non-empty lines joined by ` — ` (`MAX_STDERR_LINES`). It is
folded into the connection error, which is what status and the model both show
(`src/connection.ts`):

```
Could not connect server "broken": MCP error -32000: Connection closed (stderr: fixture: configured to fail before serving)
```

Setting `debug: true` on the entry opts out: the child is spawned with `stderr: 'inherit'`,
its log goes to the host's terminal as it is written, and nothing is captured
(`src/connection.ts`). The same failure then reads:

```
fixture: configured to fail before serving          <- the child, on your terminal
Could not connect server "broken": MCP error -32000: Connection closed
```

That is the tradeoff: you get the live log instead of the diagnostic. Turn `debug` on while
debugging a server by hand; leave it off when you want failures to explain themselves in
the tool result (`src/types.ts`, `src/connection.ts`).

`streamable-http` servers have no child process, so there is no stderr to capture
(`src/connection.ts`).

## Search finds nothing for a server that was just added (cold cache)

`mcp({ search })` and `mcp({ describe })` are answered from catalogs the registry already
knows — hydrated at construction from the on-disk cache (`src/registry.ts`,
`src/metadata-cache.ts`). A server that has never been connected and has no cache entry
contributes no tool documents, so nothing about it can match. No process is started to
answer a search; that is the point of the cache (`src/registry.ts`, `src/schema.ts`).

With no catalog anywhere, the search says so (`src/proxy-tool.ts`):

```
No tool metadata is cached yet, so there is nothing to search. Call mcp({ connect: "<server>" }) for a server you know you need, then search again.
```

`mcp({})` names the affected servers and gives the exact action (`src/proxy-tool.ts`):

```
2 MCP servers configured.
  a — 0 tools (lazy, no metadata yet)
  b — 0 tools (lazy, no metadata yet)

Metadata cache: /home/you/.dsh/storages/mcp-lazy/cache.json
Search cannot find tools on a, b yet, because nothing is cached and no server has been started. Call mcp({ connect: "a" }) or mcp({ connect: "b" }) once; after that their tools are searchable without starting anything.
```

**What to do.** Call `mcp({ connect: "a" })` once. It starts the server, fetches the
catalog, writes the cache, and reports the tool count; search works offline from then on
(`src/proxy-tool.ts`, `src/registry.ts`). Calling a tool by name also works on a cold
cache, because an unknown name triggers discovery over the servers that have no catalog yet
(`src/registry.ts`, see below).

**Why there is no automatic warm-up.** Every server defaults to `lazy`, and activation
contacts no server and spawns no child process for it (`src/index.ts`). Zero processes at
load is the property the plugin exists for, and the acceptance criteria require it (AC1 in
`docs/design/plan.md`); pre-warming every configured server would spend exactly what the
plugin is meant to save. The deliberate exception is a server configured `eager` or
`keep-alive`: those are connected during activation, which is how their caches stay warm
without a `connect` call (`src/registry.ts`, `src/index.ts`).

A cache can also go cold again, in which case the same messages come back:

- The cache lives at `$DSH_HOME/storages/mcp-lazy/cache.json`, falling back to
  `~/.dsh/storages/mcp-lazy/cache.json` (`src/metadata-cache.ts`).
- An entry is used only when its config hash still matches and it is at most 7 days old
  (`DEFAULT_CACHE_MAX_AGE_MS` in `src/schema.ts`, compared in `src/registry.ts`).
- The hash covers the transport-relevant fields only: `transport`, `command`, `args`,
  `env`, `cwd`, `url`, `headers`. Editing any of them invalidates that server's catalog, so
  it is cold until the next connect; editing anything else — `includeTools`, `excludeTools`,
  `searchKeywords`, `directTools`, `idleTimeout`, `lifecycle`, `disabled`, `debug`,
  `toolCallTimeoutMs` — does not (`src/metadata-cache.ts`).
- A corrupt or unreadable cache is treated as empty rather than failing the plugin load
  (`src/metadata-cache.ts`).
- Status flags a cache-backed catalog as `metadata from cache`, and a search that used one
  says `Metadata for <server> came from the cache; connect to refresh it`
  (`src/proxy-tool.ts`).

## A tool name is not found

Resolution runs in two stages (`src/registry.ts`). First the name is matched against every
catalog already known — from cache or a live connection. Only if that fails does discovery
run: each server with no known catalog is connected, in configuration order, skipping
disabled entries, and the name is re-resolved after each one. The first server that
resolves it wins, and a server that cannot start is recorded and skipped rather than
aborting the search (`discoverAndResolve`, `src/registry.ts`).

If nothing matches anywhere, the message carries suggestions ranked from the known
catalogs, and any discovery failures (`src/registry.ts`, `src/proxy-tool.ts`):

```
No known MCP tool named "echo". Use mcp({ search: "<keyword>" }) to find the exact name.
Servers that could not start: broken: MCP error -32000: Connection closed (stderr: fixture: configured to fail before serving)
```

If you believe the tool exists, check `mcp({})`: a server marked `no metadata yet` has no
catalog to search or resolve against. Connect it once and try again.

**The same tool name on two servers.** Resolution only considers known catalogs, so while
just one server's catalog is known the name resolves there (`#findMatches`,
`src/registry.ts`). Once both are known, the gateway refuses to guess:

```
"echo" exists on more than one server: one:echo, two:echo. Add server to choose one.
```

Disambiguate with the `server` argument, which restricts resolution to that server:
`mcp({ tool: "echo", server: "two", args: { … } })`. `mcp({ describe })` accepts `server`
the same way (`src/proxy-tool.ts`, `src/registry.ts`).

A tool may be addressed by any of its spellings: the qualified name (`one__echo`), the tool's
own name (`echo`), the tail after the prefix, `one:echo`, or `one/echo` (`#findMatches`,
`src/registry.ts`). Note that the server name alone addresses nothing. Qualified names are a
pure function of `(serverName, originalName)`: `serverName__originalName`, normalized to
`[A-Za-z0-9_-]`, truncated at 64 characters with a 12-hex-character hash suffix appended
whenever normalization changed anything or the normalized name was already too long
(`src/naming.ts`).

A `disabled` server is never started (`src/registry.ts`). Naming it as the `server` hint
answers `Server "<name>" is disabled in configuration.`, and `mcp({ connect: "<name>" })`
reports `Could not connect server "<name>": mcp-lazy: server "<name>" is disabled in
configuration` (`src/proxy-tool.ts`, `src/registry.ts`). A catalog cached from when the server
was enabled is still hydrated and searchable, and calling one of those tools fails with
`Calling "<qualified>" on server "<name>" failed: mcp-lazy: server "<name>" is disabled in
configuration`.
