# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **The native-server warning now accounts for `directTools`.** All four of its sentences give advice
  about bringing a server into this gateway, and every one of them assumes that doing so keeps its
  schemas out of the request. `directTools` breaks that assumption, because it makes this gateway
  register tools natively itself: "add it here" is then *counterproductive* for a server only the
  native plugin serves, and "remove it from one of the two" is incomplete for one both serve. Each
  sentence now ends with the setting named when it applies — *"Keeping it here does not stop those
  schemas while `directTools` is set, because this gateway registers such tools natively itself."* —
  and names only the affected servers when a group mixes promoted with unpromoted ones
  (`src/proxy-tool.ts`, `src/registry.ts`).

  The predicate is `McpGatewayRegistry.promotesNatively`, which reads configuration rather than the
  catalogs, so its answer does not change after a first connect. It deliberately ignores
  `directTools: 'search'`, which stages tools until a search matches rather than registering them.
  The case-only sentence asks it about the *local* spelling, because that is the row its advice tells
  the reader to keep — asking about the native name would always answer no.

- **A `disabled` server is no longer promoted.** `directToolSelections` and `searchModeServers` read
  the promotion setting and the known catalog but never looked at `disabled`, so a switched-off
  server's tools were registered as real tools — in every request, while `ensureConnected` rejects a
  disabled entry outright, which made every call to one fail with *"is disabled in configuration"*.
  The documented meaning of that flag is "kept visible in status, never served", and promotion now
  agrees with it. Both halves of promotion were affected: the blanket form registered the tools and
  the `'search'` form staged them, and a staged tool becomes native the moment a search matches it.

  Reachable only with `directTools` set — it defaults to off — and only through the metadata cache,
  because connecting is exactly what a disabled entry will not do. That is also why the regression
  test seeds the cache rather than a stub connection (`src/registry.ts`).

### Changed

- `docs/configuration.md` says that a disabled server is not promoted, and that the status listing
  names `directTools` when it applies.

## [0.3.2] - 2026-09-15

### Fixed

- **Two of the three residues `0.3.1` declared are gone.** The listing renders a fourth sentence for
  a native name that differs from one of this gateway's own only by case: both plugins key servers by
  exact name, so the two are separate entries rather than one, and the old "This gateway does not have
  it; add it here" left two servers doing the same job while contradicting the listing printed
  directly above it. It names the local spelling it nearly matched — the *enabled* one when a
  switched-off variant folds onto it too, and each spelling carries its own `(switched off)` marker
  rather than one flag for the whole sentence — and its
  advice reduces rows ("keep one row and delete the rest") rather than merging names. Merging was the
  first cut's advice and it was not executable: mcp-client answers a second row sharing a
  `serverName` with `already in use by another mcp-client instance` (`src/proxy-tool.ts`).
- A natively-enabled entry whose `serverName` this gateway cannot use is no longer dropped in
  silence. `detectNativelyRegistered` substitutes a placeholder when that field is not a plain
  string, and that is what a `!!js` expression looks like in the loader's raw options — the loader
  evaluates it only for the config it hands the plugin — so such a row registers tools under its
  evaluated name while the listing said nothing at all. The notice enumerates exactly what it counts:
  a computed expression, a missing or empty field, or a name outside `SERVER_NAME_PATTERN`, which are
  the strings the same filter drops. The count is taken before deduplication, because two unmatchable
  rows are two rows while two rows sharing a real name are one server — the first cut said `1 entry`
  for two rows, and counted the placeholder alone, so a blank row beside a computed one was invisible
  to it. The wording claims *matchability*, not absence: a configuration may spell the placeholder
  literally, and "has no `serverName`" would be false of that one.
- The placeholder has a name and a doc rather than a bare literal inside
  `detectNativelyRegistered`'s loop: `UNNAMED_NATIVE_NAME` in `src/types.ts`. The listing does not
  read it back, because it treats every unmatchable string the same way.

The third residue stands. With `directTools: true` this gateway promotes tools natively itself, so
neither sentence's advice restores the saving on its own; fixing it means threading that setting into
`renderStatus`, which the registry does not expose (`src/proxy-tool.ts`, `src/registry.ts`). It stays
declared rather than quietly dropped.

### Changed

- `docs/configuration.md` carries both new sentences in its table of what `mcp({})` says.

## [0.3.1] - 2026-09-14

### Fixed

- **The native-server warning now says only what it checked.** `detectNativelyRegistered` reports
  every enabled `@deepseek-ai/dsh-mcp-client` entry, whether or not this gateway serves it too,
  while the notice asserted overlap for all of them — *"is also configured in … Both plugins now
  work"* — and told the user to "move those servers here". Two adversarial reviews of the fix
  found five clauses that were wrong, each in a state the tests did not cover:

  - **"move those servers here" was unsafe.** For an entry this gateway already lists with
    `disabled: true`, the server is not absent — it is here and switched off. Adding a second
    entry with the same `serverName` makes the registry constructor throw `mcp-lazy: duplicate
    serverName`, so following the advice would have stopped the plugin from loading. That state
    now says to clear the flag instead.
  - **"Both plugins now work" was a liveness claim**, and the listing it is appended to prints
    `failed` plus the spawn error for a server whose start failed. It contradicted its own output.
  - **"so those schemas enter every request" was another one**, this time about the other plugin. A
    native row whose `config` mcp-client rejects — it requires `transport` plus `command` or `url`,
    not just `serverName` — registers nothing, and neither does a row whose server is down, because
    mcp-client drops a server whose reconnect budget is spent. The sentence now states that
    plugin's *mode* rather than an effect on the current request.
  - **A native entry with no usable `serverName` registers nothing either**, so it was named in a
    warning it could not belong to. Names failing `SERVER_NAME_PATTERN` are ignored, as are
    non-strings from the exported array seam, where `RegExp.test` coerces and `join` rendered
    `undefined` as nothing — `()` reached a sentence. The *container* is checked too: only an array
    is read, so a JavaScript caller passing anything else degrades to no warning at all — where
    `0.3.0` raised `TypeError: native.join is not a function`, and the revision in between spelled
    a bare string `'abc'` into three servers named `a`, `b` and `c`.
  - **A name a duplicated loader entry repeats** is counted once instead of twice.

  The warning renders one of three sentences — configured both here and there, listed here with
  `disabled: true`, or absent here — each with its plural form, each stating configuration and the
  config action that applies, and each offering to disable the native row only "if you do not need
  it", since that leaves nothing serving the server. Every sentence is pinned in
  `test/unit/proxy-tool.test.ts`; the failed-start contradiction is built against a real child
  process in `test/unit/connection.e2e.test.ts`, and `test/unit/plugin-load.test.ts` now asserts
  the sentence rather than just the server names.

  Residues, all deliberate and none of them silent to the user:

  - **Case-only differences are reported as absent.** This gateway keys servers by exact name, so a
    native `n` beside a configured `N` reads as a server it does not have — while the listing two
    lines above prints `N`. No clause is false about the *name*; the diagnosis is wrong about the
    *server*, and it is the one surviving case where a sentence can look like it contradicts the
    listing it belongs to.
  - **With `directTools: true` this gateway promotes tools natively itself**, so neither "add it
    here" nor "remove it from one of the two" restores the saving on its own (promotion also needs
    a catalog, so a cold cache promotes nothing). Neither sentence promises an outcome, so neither
    is false; both are incomplete in that configuration.
  - **A computed `serverName` is not reported at all.** `!!js` in a native row's config leaves the
    raw expression node in the loader entry, so detection reads it as `(unnamed)`, the pattern
    filter drops it, and mcp-client goes on to register whatever the expression evaluated to. That
    is a false negative, which is the safe direction, but it is a real one.

## [0.3.0] - 2026-09-14

### Added

- **`/mcp-adopt`** — the move `adopt` makes, from inside the GUI. The status output has always
  told you a server was configured twice (*"move those servers here"*), but acting on that meant
  leaving the session for a terminal. The command reuses the published CLI rather than
  reimplementing it, so the planner, the byte-preserving edits, the backups and the atomic write
  stay one code path. A bare `/mcp-adopt` is a dry run; `/mcp-adopt apply` writes. It is reached
  through `ctx.inject(['commands'])` rather than the plugin's own `inject` list, because waiting
  for a command registry would leave the gateway inactive on any composition that has none — the
  one regression this plugin must never ship. Writing is not cancellable (the CLI renames two
  files in sequence, so a signal between them leaves half a move), every run is bounded by a
  timeout, and a successful write is followed by a re-plan whose result is shown to you, so
  "written" comes with evidence instead of an assurance.
- `adopt` now reports the move's **blast radius across profiles**. The native row usually lives in
  the *home* patch, which every profile reads, while this plugin's row lives in one profile's
  patch — so disabling the former takes the server away from every other profile too, and those
  profiles have no gateway to receive it. The plan now names them and gives both ways out. On a
  machine where this is the configuration, a dry run says so before anything is written.

### Fixed

- **`npx dsh-mcp-lazy-adopt` did not work on a clean machine.** The CLI is a published `bin`
  entry, but the YAML parser it imports sat in `devDependencies`, where `npx` does not install
  it: `import 'js-yaml'` from `lib/adopt-compose.js` and `lib/adopt-patch.js` died with
  `ERR_MODULE_NOT_FOUND` on the first statement. It worked on the machine it was written on
  because an unrelated package had hoisted a copy into the same `node_modules` — the kind of
  accident that survives every test written against a working tree. `js-yaml` is now a real
  dependency, and a new test scans every bare import in `lib/` and `scripts/` against the
  manifest so the next one cannot hide.
- The `inject` contract in the plugin-load tests is now modelled rather than assumed: the fakes
  gained the `inject` seam, and the suite asserts the gateway registers its tool with no command
  registry present.
- **A malformed metadata cache no longer stops the plugin from loading.** The cache was checked
  only as far as "it is an object with a version and a `servers` key"; an entry that was `null`,
  or one missing its `tools` array, threw a `TypeError` out of the registry constructor and took
  the whole gateway down with it — every server, including the healthy ones. Entries are now
  validated one at a time and an unusable one is dropped, which is what the module always claimed
  it did.
- **Cancelling a call is no longer recorded as a server failure.** A caller who walked away — a
  cancelled request, an aborted signal — was written into the same failure map a genuine startup
  error goes to, which opened the 60-second retry window against a server that had done nothing
  wrong: the next caller, who cancelled nothing, was refused with a message about a failure that
  never happened. A cancellation now leaves no trace; a real failure still backs off.
- **The on-disk cache is additive across processes instead of last-writer-wins.** Every DSH
  process pointed at one `$DSH_HOME` shares the file, and each wrote back the snapshot it had read
  at startup, so a GUI and a CLI deleted each other's catalogs and search kept falling back to a
  cold start. The file is re-read and merged before each write. Entries this process cannot judge
  are kept rather than filtered against its own configuration — profiles share one cache file and
  do not share a server list, so a server this process does not know is far more likely to belong
  to another profile than to have been deleted.
- **The version this plugin reports to every MCP server came from a literal**, and had already
  fallen two releases behind: servers were told `0.1.0` while the package was `0.3.0`. It is read
  from `package.json` now, and a test compares the two so the next drift fails.
- **A long-lived abort signal accumulated one listener per connect attempt.** The listener was
  registered `once` and never removed when the attempt it belonged to settled first, so a reused
  signal grew a listener — and a captured promise — per call, silently, because Node does not warn
  at these counts.
- **A failure inside a catalog-changed listener was recorded where nothing read it.** The empty
  catch that used to swallow it was replaced, but the map the replacement wrote to had no
  consumer outside its own test, so the failure was still invisible to `status`. The registry now
  falls back to the connection layer's errors, and a server that is up but whose refresh threw
  reports the reason without being downgraded to failed.
- **A promoted native tool stayed callable after its server withdrew it.** Promotion only ever
  added: a tool the refreshed catalog no longer offered kept its native registration and went on
  dispatching to a name the server had dropped, failing on every call. Promotion is now
  revocable. `freezeDirectTools` stops the surface from *growing*; it does not pin a withdrawn
  tool in place, because a stable-but-broken registration is worse for the model than one that
  disappears — the proxy still reaches it either way.
- **The two result renderers had drifted.** The proxy path and the promoted-native path each had
  their own copy, and the native copy dropped `structuredContent` entirely: a server returning
  only structured content showed *"returned no content"* once promoted and the JSON when it was
  not. One renderer in `src/projection.ts` now serves both.
- **`dsh-mcp-lazy-adopt` could not write on Windows.** The staged temp file name was built by
  splitting on `/`, which returns the whole path on a system that separates with `\` — putting
  `C:\…` into a file name, where the colon is illegal. Every run there failed with "cannot
  write". It asks `node:path` now, which also makes the Windows contract testable from a POSIX
  host — the reason the bug reached a release at all.
- The cache directory and file are created `0700` and `0600`; the file previously took the
  ambient umask.

### Changed

- **Lint is now a gate.** `oxlint` plus a zero-dependency column checker run inside `check` and
  therefore inside CI. The checker enforces the `.editorconfig` limit oxlint does not implement
  (it has `max-lines`, not `max-len`), and its baseline is a per-file count that fails when it
  grows rather than a list of exempt files.
- `failureBackoffMs` is a supported setting: milliseconds, minimum `0`, default `60000`, and `0`
  retries immediately. It had been reachable and effective all along while the documentation and
  the type both said no user-facing spelling existed.
- `idleWindowMs` accepts only a function. A scalar used to pass validation and then be discarded,
  which is the failure mode this plugin exists to prevent: a setting that looks configured.
- The `RECONNECT_*` constants are gone. Nothing referenced them, and the plugin has no reconnect
  timer — a dropped server is restarted by the next call that needs it.
- `executeProxy` is a dispatcher over per-action handlers, and both result paths share one
  renderer. The model-facing surface is byte-identical: `11` parameters, `1525` bytes.
- The README documents the four search parameters (`regex`, `includeSchemas`, `limit`, `offset`),
  which had no user-facing description at all, and names `directTools`, which the landing page
  never mentioned.

## [0.2.1] - 2026-09-14

### Fixed

- **The `mcp` tool did nothing at all.** A host that reserves `mcp` for "call any
  tool" dispatches arguments to that name as
  `{ tool: "<the tool being called>", args: <its arguments> }` rather than passing
  them through. This plugin's tool is called `mcp`, so it collides with the
  reserved name and received the envelope: `{ search: "x" }` arrived as
  `{ tool: "mcp", args: { search: "x" } }`, the gateway read `tool` as *a tool to
  call on some MCP server*, and every call answered `No known MCP tool named
  "mcp"`. The plugin loaded, listed its tool, and could not search, describe,
  connect or call anything — which is every reason it exists. The envelope is now
  unwrapped before dispatch. Reported by the maintainer, who noticed the tool
  answering nonsense immediately after installing 0.2.0.

## [0.2.0] - 2026-09-14

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
- The test counts quoted in `README.md`, `README-zh.md` and `CONTRIBUTING.md` now match the
  suite instead of trailing it.

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

[Unreleased]: https://github.com/wings1848/dsh-mcp-lazy/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/wings1848/dsh-mcp-lazy/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/wings1848/dsh-mcp-lazy/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/wings1848/dsh-mcp-lazy/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/wings1848/dsh-mcp-lazy/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/wings1848/dsh-mcp-lazy/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/wings1848/dsh-mcp-lazy/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/wings1848/dsh-mcp-lazy/releases/tag/v0.1.0
