# Contributing to dsh-mcp-lazy

Bug reports, documentation fixes, and pull requests are welcome. This file covers
how to build and test the plugin, what the tooling enforces, and what a change is
expected to include.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). For
security issues, follow [SECURITY.md](SECURITY.md) instead of opening a public
issue.

## Requirements

- Node.js `>=22.18.0` (`package.json` `engines`). The test files are TypeScript
  run directly by Node's built-in type stripping (`package.json` `test` script),
  which is why the floor exists.
- pnpm (`package.json` `packageManager`: `pnpm@12.3.4`, lockfile
  `pnpm-lock.yaml`).
- A DSH installation on the same machine. The `@deepseek-ai/*` packages are peer
  dependencies that the harness supplies at runtime, and
  `scripts/link-dsh.mjs` links them out of that installation.

## Setup

```bash
git clone https://github.com/wings1848/dsh-mcp-lazy.git
cd dsh-mcp-lazy
pnpm install
pnpm test
```

`pnpm test` runs `pretest` first (`package.json`), which builds `lib/` and then
runs `scripts/link-dsh.mjs`.

### Why `link-dsh` is mandatory

The plugin imports `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`,
`@deepseek-ai/dsh-subprocess`, and `@deepseek-ai/schemastery` at runtime, and the
harness supplies those from its own installation. Because they are also
devDependencies, a package manager will materialize private copies under this
package's `node_modules` — and a private copy can be a different release than the
harness you are running (the commit history records `0.1.5-rc.2` from the registry
against the `0.1.5-rc.1` in the harness). Code that builds tool definitions with a
different module instance than the runtime that registers them hits a
class-identity mismatch: either a confusing failure or a silent one-release
drift.

`scripts/link-dsh.mjs` closes that hole by replacing those copies with symlinks
into the running installation. It looks for the installation via
`DSH_INSTALL_ROOT`, then `$BUN_INSTALL/install/global/node_modules`, then
`~/.bun/install/global/node_modules`, then ordinary module resolution; if it finds
none it says so and does not guess. Pass `--check` to report without writing:
`node scripts/link-dsh.mjs --check`.

## Commands

All of these come from `package.json` `scripts`.

| Command | What it does |
| --- | --- |
| `pnpm build` | `tsc -p tsconfig.json` — compiles `src/` to `lib/` with declarations and source maps. |
| `pnpm typecheck` | The same project with `--noEmit` — type errors only, no output. |
| `pnpm test` | `node --test "test/unit/*.test.ts"`. Runs `pretest` first (build, then `link-dsh`). Reports 354 tests in 84 suites; `README.md` carries the same test count in its quick start. |
| `pnpm test:types` | `tsc -p tsconfig.test.json` — type-checks the test sources as well, which `typecheck` does not cover. |
| `pnpm check` | `typecheck` then `lint` then `build` then `test:types`, in that order. Run this before opening a pull request; CI runs the same command. |
| `pnpm lint` | `oxlint src scripts test` (config: `.oxlintrc.json`), then `node scripts/check-style.mjs` for the rules in `.editorconfig` that oxlint does not implement — the 100-column limit, LF endings, trailing whitespace, final newline. |
| `pnpm link-dsh` | `node scripts/link-dsh.mjs` — symlinks the four peer packages from the running DSH installation into `node_modules`. |
| `pnpm measure:surface` | `node scripts/measure-surface.mjs` — prints the constant model-facing surface: tool name, parameter count, wire bytes, approximate tokens. An optional server count adds a line stating that those servers cost nothing further per request. |
| `pnpm measure:savings` | `node scripts/measure-token-savings.mjs` — starts a real MCP server (a bundled fixture by default, or `--npx <package> [args]`), renders what native registration of its tools would cost, and reports the ratio against this plugin's fixed cost. |

`prepack` also runs `build`, so a packed or published tarball ships a fresh `lib/`
even though `lib/` is gitignored.

## Code conventions

Most of these are enforced by `tsc` (`tsconfig.json`). Formatting is enforced by
`pnpm lint`, which is `oxlint` plus `scripts/check-style.mjs` — there is no
formatter, so match the surrounding code rather than reformatting a file.

- `strict` and `noUncheckedIndexedAccess` are on. Indexed access yields
  `T | undefined`; handle it rather than asserting it away.
- `erasableSyntaxOnly` is on. Node executes the test files by stripping types, so
  it can only run syntax it can erase. That rules out `enum`, namespaces
  containing runtime code, and constructor parameter properties.
- `verbatimModuleSyntax` is on. A type-only import must be written
  `import type { X } from './x.js'`.
- ESM only (`"type": "module"`, `module`/`moduleResolution` `NodeNext`). Relative
  imports carry an explicit `.js` extension in the `.ts` source, e.g.
  `import { LazyConnections } from './connection.js'`.
- Formatting follows `.editorconfig`: UTF-8, LF, two-space indent, 100-column
  maximum, final newline. `scripts/check-style.mjs` fails a *new* offender; the
  files that predate the check are listed inside it and warn instead.
- `src/schema.ts` defines the one model-facing tool and its 11 parameters. Any
  edit there changes the fixed per-request cost. Tests assert that the surface
  stays constant, and `pnpm measure:surface` prints the current numbers; if a
  change moves them, say so in the pull request.

## Tests

- Tests live in `test/unit/` as `*.test.ts` and run under Node's built-in test
  runner. There is no test framework.
- They import the **built output**, for example
  `import { OutputGuard } from '../../lib/output-guard.js'` — never from `src/`.
  `lib/` is gitignored, so build before running a single file directly:
  `pnpm run build && node --test test/unit/output-guard.test.ts`. (`pnpm test` covers
  this, because `pretest` builds — but Node's own `node --run test` does **not** run
  pre/post hooks, so that spelling silently tests the previous build. Measured: the
  `lib/proxy-tool.js` mtime is identical before and after such a run.)
- **A stale `lib/` fails green, not loudly.** Edit `src/`, skip the build, and the
  suite runs the *previous* build and passes — measured: one source change left
  `test/unit/adopt-paths.test.ts` at 6/6 green, and the same change went to 3
  failures once `node --run build` ran. So a green run proves nothing unless the
  build in front of it succeeded, which is why `check` and CI put the build ahead
  of the tests rather than beside them.
- A bug fix comes with a regression test that was observed to fail before the fix.
  Run the new test against the unpatched code and keep the failing output; that
  record is what distinguishes a regression test from decoration. Section 10 of
  `docs/design/parity-pi-mcp-adapter.md` documents the cases where this was done
  (two of the three cache-filter tests were confirmed red on the reverted code).
- Prefer real child processes to mocks where lifecycle is involved: the suite
  starts `test/fixtures/mcp-server.mjs` and asserts process facts (spawn counts,
  pid reuse, no second spawn during backoff), and asserts that nothing was started
  by replacing spawnable executables with failing stubs and rewriting `PATH`
  (`README-zh.md`).
- Run `pnpm test:types` when you touch a test file; `pnpm check` runs it for you.

## Commit messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `build:`, `docs:`, `chore:`, `test:`, `refactor:`.

The style used in this repository is a short imperative subject line, then a body
that explains **why** the change is needed — not what the diff contains. An
example from the history:

> build: migrate from npm to pnpm and make scripts package-manager agnostic

Its body explains the package-manager convention, the choice of `node --run` so
the scripts work under any package manager, the quoting of the test glob for
Windows, and the class-identity hazard that motivated re-linking the peer
packages. That is the level of reasoning a body is expected to carry here.

## Pull requests

- Fork the repository, or branch off `main`. `main` is the only long-lived branch.
- One logical change per pull request. Unrelated cleanups belong in their own
  pull request.
- Keep `main` green: `pnpm check` and `pnpm test` must pass. Report anything
  unusual in the output.
- Behaviour changes need tests. Documentation-only changes do not.
- Explain the reasoning in the pull request body, and flag any change that moves
  the model-facing tool surface or its byte count.

## Reporting bugs

Open an issue with the plugin version, your Node version, the relevant
configuration snippet (redact credentials), what you expected, and what happened.
Failures that involve a server are much easier to act on with the server's stderr
included — set `debug: true` on that server entry to forward it to your terminal
(`README-zh.md`).

## Releasing

Maintainers only.

1. Add a `## [<version>] - <date>` heading at the top of `CHANGELOG.md` for the
   entries that were not released yet, then update the link definitions at the
   bottom of that file: give the new version its own `[x.y.z]` link, and repoint
   `[Unreleased]` at `compare/v<version>...HEAD`.
2. Set the same version in `package.json`. The release workflow refuses to publish
   when the tag and `package.json` disagree, so this is enforced rather than
   remembered.
3. Commit, then tag and push:

   ```bash
   git tag v0.3.0
   git push origin v0.3.0
   ```

4. `.github/workflows/release.yml` re-runs `pnpm run check` and `pnpm test`, then
   publishes with provenance and creates the GitHub release from the tag.

**The very first publish has to be done by hand**, because a trusted publisher can
only be configured for a package that already exists on npm. From a checkout, with
npm logged in interactively in a browser:

```bash
npm login
npm publish --access public
```

Then, at `https://www.npmjs.com/package/dsh-mcp-lazy/access`, add a trusted
publisher with:

| Field | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `wings1848` |
| Repository | `dsh-mcp-lazy` |
| Workflow filename | `release.yml` |
| Environment | *(leave empty)* |

After that, tag pushes publish on their own. The workflow authenticates by
exchanging a GitHub OIDC token for a short-lived npm credential, so there is no
long-lived `NPM_TOKEN` secret to store or rotate. `id-token: write` in the
workflow is what permits the exchange; without a configured trusted publisher the
publish step fails with an authentication error rather than falling back to
anything.

Provenance is published with every release, which is why the publish step uses
`npm publish` rather than `pnpm publish` — the npm CLI is the reference
implementation for OIDC trusted publishing, and pnpm's support for it has been
version-dependent. npm only packs and uploads here, so the pnpm workspace is not
a problem.
