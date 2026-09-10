# Development

## Requirements

- **Node.js >= 22.18.0.** The test files are TypeScript executed directly by Node's built-in
  type stripping, which is on by default from 22.18.0 and stable from 24.12.0. There is no
  test transpiler and no `ts-node`.
- **pnpm.** Declared as `packageManager` in `package.json`.

## Setup

```bash
git clone https://github.com/wings1848/dsh-mcp-lazy.git
cd dsh-mcp-lazy
pnpm install
pnpm test
```

If `pnpm test` fails with an error about `@deepseek-ai/dsh-tools`, see
[Why `link-dsh` is mandatory](#why-link-dsh-is-mandatory).

## Commands

| Command | What it does |
| --- | --- |
| `pnpm run build` | `tsc -p tsconfig.json`, emitting `lib/` |
| `pnpm run typecheck` | Type-check `src/` without emitting |
| `pnpm run test:types` | Type-check `src/` and `test/` together |
| `pnpm test` | Build, relink the peers, then `node --test` over `test/unit/*.test.ts` |
| `pnpm run check` | `typecheck`, then `build`, then `test:types` — what CI runs before the tests |
| `pnpm run link-dsh` | Symlink the `@deepseek-ai/*` peers from the running DSH install |
| `pnpm run measure:surface` | Print the constant model-facing cost in bytes and parameters |
| `pnpm run measure:savings` | Compare native registration against the gateway |

`test` has a `pretest` hook that builds and relinks, so a fresh checkout can go straight to
`pnpm test`. There is no separate build step to remember.

**The order inside `check` is not cosmetic.** `typecheck` reads only `src/` and needs nothing
built. `test:types` reads `test/` as well, and the tests import `../../lib/*.js` — so it needs
`lib/` to exist. `build` therefore has to sit between them. With `test:types` first, `check`
passes on any machine where `lib/` is already lying around and fails on every fresh clone with
twenty-nine `TS2307: Cannot find module '../../lib/...'` errors. That is not hypothetical; it
is what CI caught on the first push.

To reproduce a runner locally, delete both generated directories before believing a green run:

```bash
rm -rf lib node_modules
pnpm install --frozen-lockfile && pnpm run check && pnpm test
```

`--test-name-pattern` is the fast loop while iterating:

```bash
node --test --test-name-pattern='M9' "test/unit/connection.e2e.test.ts"
```

## Why `link-dsh` is mandatory

`@deepseek-ai/cordis`, `dsh-tools`, `dsh-subprocess`, and `schemastery` are **peer
dependencies**. The harness supplies them at plugin load time from its own installation.

If a private copy also exists under this package's `node_modules`, the plugin builds tool
definitions with a *different* `dsh-tools` instance than the runtime that registers them.
That is a class-identity mismatch: it fails confusingly, or silently drifts a release behind
— the registry's `latest` tag currently points at `0.0.1-rc.1` while the harness runs
`0.1.5-rc.1`, so a naive install gets something quite different from what the plugin was
built against.

`scripts/link-dsh.mjs` closes that gap by symlinking the peers from the running DSH
installation. It runs automatically as part of `pretest`. It locates the installation from
`DSH_INSTALL_ROOT`, then `BUN_INSTALL`, then `~/.bun/install/global/node_modules`, then
Node's own resolution — so it works for a global install and for a profile-local one.

If no DSH installation is found it prints a warning and exits **0**, so `pnpm test` still
runs against the registry copies. That is what CI does, where no harness is installed.

**Do not pin `devDependencies` to the harness version.** Doing so looks like it buys
consistency and actually costs it: the direct packages get pinned while the peers *they*
depend on — `dsh-agent`, `dsh-session`, `dsh-llm`, and the rest, which pnpm installs
automatically — keep resolving to the newest prerelease. The result is a lockfile that mixes
two prereleases of the same scope, one of which is one release ahead of what actually runs.
The harness itself is uniformly versioned; the lockfile should be too.

So `devDependencies` carries ordinary ranges, and the committed `pnpm-workspace.yaml`
excludes the `@deepseek-ai/*` scope from pnpm 12's 24-hour `minimumReleaseAge` rule —
without that, a fresh clone cannot install at all, because a harness release is usually
hours old. Neither of those is what makes a local checkout match the running harness;
`link-dsh` is, and it runs on every test.

## Layout

```
src/
  index.ts            the cordis plugin: name, inject, Config, apply()
  schema.ts           the proxy tool's name, parameters, and defaults
  registry.ts         server state, the metadata cache, search, invocation routing
  connection.ts       transports, the connection lifecycle, idle reaping, stderr capture
  proxy-tool.ts       the single model-facing tool
  search-ranking.ts   scoring, the coverage gate, and the regex guard
  output-guard.ts     the output ceiling and spill files
  metadata-cache.ts   the on-disk catalog cache
  direct-tools.ts     optional native promotion
  naming.ts           qualified-name handling
  types.ts            shared types and the public config shape
test/
  unit/*.test.ts      executed directly by Node; see below
  fixtures/mcp-server.mjs   a real MCP server, spawned as a child process
scripts/              link-dsh and the two measurement tools
docs/                 configuration, troubleshooting, this file, and docs/design/
```

Two conventions are easy to get wrong:

- **Tests import from `../../lib/*.js`, not from `src/`.** They exercise the built output, so
  `lib/` must be current. `pretest` handles that; running `node --test` by hand does not.
- **Relative imports in `src/` carry a `.js` extension**, because the package is ESM under
  `module: NodeNext`. TypeScript resolves `./schema.js` to `src/schema.ts`.

Anything under `test/` that is not a test file is a different case: Node runs it directly by
stripping types, and it requires the **exact** extension, so a helper is imported as
`../helpers/tmp.ts` — not `.js`, and not without an extension. `src/` is compiled, `test/` is
not, and the two follow opposite rules for the same syntax.

## Tests

`test/unit/connection.e2e.test.ts` spawns `test/fixtures/mcp-server.mjs` for real, so its
assertions are about processes rather than mocks. The fixture appends a line to
`FIXTURE_START_COUNT` on every start, which is how "was a new process spawned" is observed
without guessing from pids. Other knobs — `FIXTURE_FAIL`, `FIXTURE_PID_FILE`,
`FIXTURE_READY_FILE`, `FIXTURE_EXIT_AFTER_MS` — are documented at the top of the fixture.

Nothing in the suite touches the network, and no test needs a DSH installation.

Two properties the suite deliberately guards:

- **Activation is quiet for a default configuration.** `plugin-load.test.ts` asserts that
  applying the plugin registers exactly one tool and spawns nothing. Only servers configured
  `eager` or `keep-alive` are contacted at activation.
- **The model-facing surface does not move.** The proxy tool's name, parameter count, and
  rendered size are asserted, because they are the plugin's entire value proposition.

## Code conventions

Enforced by the compiler, not by review:

- `strict`, plus `noUncheckedIndexedAccess` — indexed access yields `T | undefined`.
- `erasableSyntaxOnly` — no `enum`, no `namespace` with runtime code, no constructor
  parameter properties. Node's type stripper cannot erase them.
- `verbatimModuleSyntax` — type-only imports must use `import type`.
- Relative imports use explicit `.js` extensions.

`tsconfig.json` deliberately has no `paths` or `baseUrl`. Node's test runner ignores
`tsconfig.json` entirely, so a path mapping would only ever hide a real resolution failure.

## Measuring

Both measurement scripts render the same tool definitions the same way — JSON bytes, then
four bytes per token — so the ratio is meaningful even though the absolute token count is an
estimate.

```bash
node scripts/measure-surface.mjs                                  # the constant cost
node scripts/measure-token-savings.mjs                            # local fixture
node scripts/measure-token-savings.mjs --npx chrome-devtools-mcp@1.6.0
node scripts/measure-token-savings.mjs 3                          # three fixture servers
```

If you change anything the model sees, `measure-surface.mjs` must still print 1525 bytes and
11 parameters. Any other number is a regression to the plugin's whole reason for existing,
and it needs to be a deliberate decision rather than a side effect.
