# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `adopt`: a command that moves servers configured under `@deepseek-ai/dsh-mcp-client` into
  this plugin. Every writer of MCP configuration in this ecosystem produces such a row — the
  config-manager panel, `@hyzyn/dsh-codegraph`, and a hand-written config — and a server listed
  in both places cancels the saving this plugin exists for with no error and no symptom. The
  command composes every patch layer the way a boot does, marks each original row
  `disabled: true` in place, and appends the server to this plugin's `servers` list. Non-target
  bytes are untouched — comments, blank lines and `!!js` expressions survive exactly — a row it
  cannot move safely is reported with a reason instead of being half-moved, and the default is a
  dry run. Reachable as `dsh-mcp-lazy-adopt`, or `node scripts/adopt.mjs`.
- `mcp-lazy/adopt` is now an export path, so the planning function can be reused: `planAdoption`
  is pure, takes the composed rows and the existing config, and returns a plan whose `edits`
  array is a byte-exact edit script.
- The docs now say how many tests there are without being wrong: 263 in 64 suites.

### Fixed

- The "also configured in `@deepseek-ai/dsh-mcp-client`" notice in `mcp({})` is no longer
  computed once at plugin load. The loader re-runs only the entries whose *own* config changed,
  so a server moved out of the other plugin by editing another layer left this plugin reporting
  a conflict that no longer existed — wrong in the direction that hides a restored saving. The
  server list is now read per status render.
- A co-mounted row is recognised as disabled whether the flag sits on the loader entry or on the
  row itself (`disabled: true` inside an `insert` item), which is the form `adopt` writes.
- The `adopt` command's entry-point check resolves symlinks, so the `dsh-mcp-lazy-adopt` bin entry
  actually runs once installed. Comparing `process.argv[1]` against `import.meta.url` without
  resolving them made the installed command print nothing and exit 0 — indistinguishable from
  "nothing to do", which is the one failure this command must never have.
- Three ways `adopt` could damage or silently skip a configuration, found by an adversarial review
  before release. Each is covered by a test that fails without its fix, and the fixes are described
  in `docs/design/adopt-native-rows.md` §12:
  - `disabled: true` could be inserted *inside* a nested block — a block scalar or an `env:` map
    holding a `name:` of its own — producing a file the loader cannot parse, after reporting
    success. The flag now goes on the row's own key column.
  - A row's editable range covered its whole `- insert:` block, so a block holding two rows made the
    second one unfindable and aborted the run. Ranges are now one item each.
  - A row was located by the file the dump's provenance marker named, and dropped when that file did
    not literally declare it. Rows are now looked up in every patch layer, and one that cannot be
    located is reported and counted as a failure rather than skipped in silence.
- `adopt --write` is now all-or-nothing. Every replacement is written beside its file first and the
  files are swapped in afterwards; a failure in the swap restores the already-swapped files from
  their backups. Previously a failure on the second file left the first one rewritten, which
  disables the original row without adding the server anywhere — the server then belongs to neither
  plugin.
- `adopt` no longer rejects a whole file over a trailing comment on the `servers:` key, and no
  longer leaves a CRLF file with mixed line endings or an extra blank line.

### Changed

- `createProxyTool`'s fourth parameter accepts `readonly string[] | (() => readonly string[])`.
  Passing an array still works, so this is not a break for existing callers; passing a function
  makes the conflict notice live.

- Documentation: three files still said 179 tests where the suite had grown to
  195, and none of them explained how to configure a server that needs a token.
  `docs/configuration.md` now has a Secrets section covering the `!!js` +
  environment-variable pattern, including the three things about `!!js` that
  cost time to discover: it applies to scalars only, an expression starting with
  `!` must be quoted, and `disabled` is evaluated before the plugin sees it.

## [0.1.1] - 2026-09-11

### Added

- `mcp({})` now reports when another mounted plugin is registering MCP
  servers natively. `@deepseek-ai/dsh-mcp-client` turns every MCP tool into a
  real tool definition, so when both plugins serve the same servers nothing
  fails and the saving silently does not happen -- the one failure mode with no
  symptom to notice. The status line names the servers and tells the model to
  say so, which is the only channel that reaches the user. Detection reads the
  loader without injecting it, so running outside a cordis host reports nothing
  rather than failing, and it reads the declared entry tree rather than runtime
  state, so it does not depend on which plugin loads first (`src/index.ts`,
  `src/proxy-tool.ts`).
- A plugin-level `directTools` default (`true` or `'search'`), applied to every
  server that does not set its own. `pi-mcp-adapter` exposes the same thing as
  `settings.directTools`, so a configuration carried over from it now behaves
  the same way, and "expose everything natively" no longer means editing every
  server row. A server's own `directTools` still wins, including `false`, which
  is how one server opts out of a plugin-wide `true` (`src/index.ts`,
  `src/registry.ts`, `src/types.ts`).

### Fixed

- Plugin-level fields the plugin does not implement were accepted and then
  ignored, the same way server-level ones were. The server check cannot see
  them, and schemastery passes unknown top-level keys through identically — so a
  typo, or a `pi-mcp-adapter` settings key such as `settings`, resolved into a
  config that looked right and did nothing. Both levels are checked now
  (`src/index.ts`).
- A server field the plugin does not implement was accepted and then ignored.
  schemastery passes unknown keys through untouched, so a configuration carried
  over from `@deepseek-ai/dsh-mcp-client` — which has `reconnect` and
  `failOnStartupError`, neither of which exists here — resolved to a config that
  looked correct and did nothing. A misspelled field name behaved the same way.
  Both now fail at load. The two `dsh-mcp-client` fields get a message saying
  what to use instead, because each needs a different answer; anything else is
  reported as an unknown field alongside the list of real ones (`src/index.ts`).
  Found by running the plugin against real MCP servers rather than the fixture:
  a field that is accepted and ignored produces no symptom, so no test that
  asserts behaviour could have caught it.

## [0.1.0] - 2026-09-11

First public release. Requires Node.js `>=22.18.0` and is ESM only. There is one
runtime dependency, `@modelcontextprotocol/sdk`; the `@deepseek-ai/*` packages are
peer dependencies supplied by the DSH host (`package.json`).

### Added

- One constant model-facing tool, `mcp`, in place of one native tool per MCP tool.
  Its schema is built from a literal and does not depend on which servers are
  configured (`src/schema.ts`): 11 parameters, 1525 bytes on the wire, roughly 381
  tokens. That figure is constant no matter how many servers are configured.
  Measured against `chrome-devtools-mcp@1.6.0` (29 tools), native registration
  would cost 21252 bytes ≈ 5313 tokens per request, so this is 92.8% less
  (`docs/design/plan.md`, `README.md`).
- Lazy connections: a server is spawned on first use and reaped once it has been
  idle past its window (default 10 minutes; `0` disables reaping). Concurrent
  first calls share one in-flight connection instead of racing, a call in flight
  is never reaped, and `notifications/tools/list_changed` refreshes the catalog
  without polling (`src/connection.ts`).
- Lifecycle modes `lazy` (the default), `lazy-keep-alive`, `eager`, and
  `keep-alive`, with a per-server `idleTimeout` override (`src/index.ts`,
  `src/registry.ts`). Only `lazy` is reaped: every other mode means "keep this
  process", so its window defaults to zero. `eager` and `keep-alive` are also
  connected while the plugin is being applied; `lazy` and `lazy-keep-alive` wait
  for first use.
- A disk metadata cache at `$DSH_HOME/storages/mcp-lazy/cache.json`, invalidated
  by a SHA-256 hash of the transport configuration and by a 7-day age bound, with
  atomic writes and a corrupt file ignored rather than fatal
  (`src/metadata-cache.ts`). This is what lets `search` and `describe` answer
  without starting anything.
- Weighted search ranking: camelCase-aware tokenization, per-field weights
  (qualified name 12, original name 10, server 8, description 5, keywords 5),
  phrase, prefix and substring bonuses, a coverage threshold for queries longer
  than two tokens, deterministic tie-breaking, and paging (`limit` defaults to 12
  and is capped at 40) (`src/search-ranking.ts`, `src/registry.ts`).
- Suggestions for an unknown tool name, a requirement to disambiguate a name
  shared by two servers, and explicit diagnostics instead of a fabricated success
  when a server fails (`src/registry.ts`, `src/proxy-tool.ts`).
- Optional native promotion through `directTools` (`true`, a list of names, or
  `"search"` for register-but-inactive) plus `freezeDirectTools` to stop the
  request prefix from moving after the first sync (`src/direct-tools.ts`).
- Output bounding, on by default: server-authored text over 50 KiB or 2000 lines
  is cut to its head, the full text is spilled to a temporary file, and the path
  is returned to the model. Tool results, `describe` schemas, and server
  instructions are guarded; the gateway's own text is bounded by construction
  (`src/output-guard.ts`).
- Failure backoff: after a server fails it is not retried automatically for 60
  seconds, and the status text reports how long ago it failed and that retries
  are suppressed. An explicit `mcp({ connect })` still bypasses the window
  (`src/registry.ts`, `src/connection.ts`).
- Bounded stderr capture for stdio servers (last 3 lines, at most 8 KiB) folded
  into connection errors, with a per-server `debug: true` to inherit stderr
  instead (`src/connection.ts`).
- Cold-cache guidance: `mcp({})` names the servers that have no cached metadata
  yet and tells the model to `connect` them once, rather than pre-warming anything
  at startup (`src/proxy-tool.ts`).
- Load-time configuration validation: a duplicate `serverName`, `stdio` without
  `command`, and `streamable-http` without `url` fail where the configuration is
  written (`src/index.ts`). Activation stays quiet by default: only servers
  explicitly configured `eager` or `keep-alive` are contacted, and those connects
  are fire-and-forget after the tool is registered, so an unreachable server
  cannot delay the tool surface or fail the plugin load.
- Configuration stays compatible with `@deepseek-ai/dsh-mcp-client`: `serverName`,
  `transport`, `command`, `args`, `env`, `cwd`, `url`, `headers`, and
  `toolCallTimeoutMs` keep their meaning, so an existing entry moves into the
  `servers` list unchanged (`src/index.ts`, `README.md`).
- Developer tooling: `scripts/link-dsh.mjs` links the peer packages from the
  running DSH installation, `scripts/measure-surface.mjs` prints the constant
  per-request cost, and `scripts/measure-token-savings.mjs` measures the saving
  against a real server.
- 179 automated tests in 47 suites, including real child-process tests for lazy
  startup, process reuse, idle reaping, cancellation, timeouts, crash recovery,
  and live tool-list refresh (`README.md`,
  `docs/design/parity-pi-mcp-adapter.md`).
- Documentation: `README.md`, `README-zh.md`, `docs/design/plan.md` (acceptance
  criteria AC1–AC18), and `docs/design/parity-pi-mcp-adapter.md` (a module-by-module
  audit against `pi-mcp-adapter` v2.33.0).
- Not in this release, by design: OAuth and bearer-token storage, MCP resources
  and prompts, sampling and elicitation, forwarding image payloads, shared
  processes, and configuration interoperability with other hosts. The boundaries
  are listed in `README-zh.md`.

### Fixed

Defects found during development — by the parity audit in
`docs/design/parity-pi-mcp-adapter.md`, by mounting the plugin in a real harness,
by an independent review before this release, and by tests that were observed to
fail first — and fixed before this release:

- A server that completed the MCP handshake but then failed `tools/list` leaked
  its child process, permanently. `connect()` only closed the client on the happy
  path, so a failure between "the server is up" and "the catalog was read" left a
  running child that was never entered into the connection state map — which made
  it unreachable by the idle sweep, by `disconnect`, and by `dispose`, the three
  mechanisms whose entire job is to end it. Every retry leaked another one. The
  failure path now closes whatever it opened. Found by review, not by the suite:
  the existing failure fixture exits before the handshake, which the SDK cleans up
  on its own, so no test covered the window at all (`src/connection.ts`).
- `apply()` discarded the disposer returned by `ctx.tools.register()`, so the
  `mcp` tool was never unregistered on teardown. That disposer is not
  fiber-scoped — the harness's own mcp-client keeps and calls the ones it gets —
  so an unload-and-reload would leave a stale tool pointing at a registry whose
  connection layer had already been disposed. The `apply` disposer also now
  awaits the registry and output-guard teardown instead of firing and forgetting
  it, since cordis waits for an async disposer and returning early let a reload
  race its predecessor (`src/index.ts`).
- The test that claimed to cover that could not fail. Its fake context cleared
  the registered-tool list inside its own `disposeAll()`, so "no tool may outlive
  the plugin scope" passed no matter what the plugin did — the exact
  decoration-instead-of-regression failure `CONTRIBUTING.md` warns about. The fake
  now returns a real unregister function and leaves the list alone, and the
  assertion was confirmed to go red when the plugin-level fix is reverted
  (`test/unit/plugin-load.test.ts`).
- `eager` and `keep-alive` never connected during activation, so both behaved
  exactly like their lazy counterparts: a documented setting that silently did
  nothing. Nothing in `apply()` or the registry ever acted on the "connect during
  activation" half of the lifecycle contract, and the existing suite could not
  catch it because that suite asserts activation stays quiet — correct for the
  default mode, wrong for these two. Found by booting the plugin in an isolated
  DSH profile and watching a fixture server's start counter stay empty. `apply()`
  now connects exactly the servers `registry.residentServers()` selects
  (`src/index.ts`, `src/registry.ts`).
- `keep-alive` was reaped like `lazy`. `resolveServer` zeroed the idle window for
  `eager` and `lazy-keep-alive` only, and this plugin has no separate keep-alive
  registry for the idle sweep to skip — which is how `pi-mcp-adapter` keeps its
  `keep-alive` servers alive. The mode promised residency and delivered a
  10-minute window. Every mode except `lazy` now resolves to no reaping
  (`src/registry.ts`).
- `scripts/link-dsh.mjs` assumed the four peer packages were siblings under one
  installation root. That holds for a global bun install but not for pnpm, where
  each package gets its own `node_modules/.pnpm/<pkg>@<ver>` directory, so the
  script reported packages as missing while leaving stale links in place. Each
  peer is now located independently (`scripts/link-dsh.mjs`).
- The suite leaked a temporary directory per `mkdtempSync` call, roughly thirty
  per run, and never removed any of them. A throwaway `DSH_HOME` is still created
  per suite, but it is now registered with `test/helpers/tmp.ts` and removed on
  process exit, including when an assertion fails. The two measurement scripts
  clean up after themselves the same way.
- The repository could not be installed by anyone. pnpm 12 refuses to install a
  package published within the last 24 hours, and the `@deepseek-ai/*` packages
  this plugin is built against are typically hours old, so `pnpm install` failed
  on a fresh clone — locally, in CI, everywhere — until the versions happened to
  age past the window. The committed `pnpm-workspace.yaml` excludes that scope
  from the age check and nothing else.
- A first attempt at the same problem pinned the four direct `@deepseek-ai/*`
  packages to exact versions, which made things worse rather than better: the
  packages pinned, the peers *they* pull in — `dsh-agent`, `dsh-session`,
  `dsh-llm`, and a dozen more — kept resolving to the newest prerelease, leaving
  a lockfile that mixed `0.1.5-rc.1` and `0.1.5-rc.2` within one scope. The
  harness itself is uniformly versioned and the lockfile now is too.
- Cached tool lists went permanently stale when a filter was relaxed. The cache
  stored the post-filter tool list while the configuration hash deliberately
  ignored `includeTools`/`excludeTools`, so removing an exclusion could not bring
  the tool back for up to 7 days — and under lazy loading, possibly forever.
  Filtering now happens on the read path and the cache holds the full list
  (`src/registry.ts`, `src/metadata-cache.ts`).
- CamelCase tool names could not be found by sub-word search: tokenization did
  not split camelCase, so `getPixels` did not match the query `pixels`
  (`src/search-ranking.ts`).
- Regular-expression search had no safety guard at all. `(a+)+c` against a
  28-character run took about 2 seconds and grows exponentially, and the pattern
  is evaluated synchronously inside the tool call, so a single search could stall
  the session (`src/search-ranking.ts`).
- A rejected regular expression was reported as "No MCP tool matches", which the
  model reads as "the tool does not exist" rather than "the pattern is wrong".
  Rejection reasons now reach the model verbatim (`src/search-ranking.ts`,
  `src/proxy-tool.ts`).
- There was no failure backoff, so a broken server was re-spawned and made to wait
  out the full call timeout on every attempt (`src/registry.ts`).
- stdio children inherited stderr, which left the SDK's `transport.stderr` null
  and a startup failure with no diagnostic at all. stderr is now piped and its
  tail is quoted in the error (`src/connection.ts`).
- `includeTools` patterns such as `read_*` did not match the qualified name
  `srv__read_dir`, because matching was done against the full name only
  (`src/naming.ts`).
- `connect` against a disabled server threw, so the model saw a failed tool
  instead of a readable diagnostic. `ensureConnected` still refuses to start a
  disabled server — the fix is that the proxy tool now catches that refusal and
  renders it as an explanation (`src/proxy-tool.ts`, `src/registry.ts`).
- The idle sweep read the cached window instead of resolving it, which made every
  server look like "never reap" (`src/connection.ts`).
- A tool call required the catalog to exist already, so the first call against a
  cold cache always failed. Resolution now discovers on demand
  (`src/registry.ts`).
- Native promotion failed silently because the harness's `defineTool` takes its
  own parameter DSL rather than a raw JSON Schema; a converter was added
  (`src/direct-tools.ts`).
- The catalog-refresh subscription was installed only by `apply()`, so tests and
  any other direct user of the registry never received it. The registry now owns
  the subscription (`src/registry.ts`).
- Installing the peer packages from the registry produced a second `dsh-tools`
  instance one release ahead of the running harness (0.1.5-rc.2 against
  0.1.5-rc.1), a class-identity hazard for every tool definition this plugin
  registers. `scripts/link-dsh.mjs` now links them from the running installation.
- The design notes claimed oversized tool output was handled by an existing
  framework spill. The harness has no framework-level truncation of tool output,
  so this release implements the output guard instead
  (`docs/design/parity-pi-mcp-adapter.md`).

### Security

- stdio children start from a scrubbed environment: variables whose names match
  `/KEY|PASSWORD|SECRET|TOKEN/i` and variables whose names begin with `DSH_` are
  dropped before spawn, and an explicitly configured `env` entry is merged on top
  of the scrub (`src/connection.ts`).
- Regular-expression search is capped at 256 characters and rejects patterns that
  nest an unbounded quantifier inside an unboundedly quantified group. The check
  is deliberately narrower than a full ReDoS analyser: overlapping alternation
  such as `(a|aa)+` and polynomial backtracking such as `a*a*a*b` are not caught
  (`src/search-ranking.ts`; see `SECURITY.md`).
- Spilled output is written with mode `0o600` under a per-process
  `dsh-mcp-lazy-output-` directory in the system temp directory, capped at 16 MiB
  per file, and removed when the plugin unloads (`src/output-guard.ts`,
  `src/index.ts`).
- Failure diagnostics quote at most the last 3 stderr lines, so a server that logs
  heavily cannot flood the model's context through an error message
  (`src/connection.ts`).

[Unreleased]: https://github.com/wings1848/dsh-mcp-lazy/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/wings1848/dsh-mcp-lazy/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/wings1848/dsh-mcp-lazy/releases/tag/v0.1.0
