# dsh-mcp-lazy

[![CI](https://github.com/wings1848/dsh-mcp-lazy/actions/workflows/ci.yml/badge.svg)](https://github.com/wings1848/dsh-mcp-lazy/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-mcp-lazy.svg)](https://www.npmjs.com/package/dsh-mcp-lazy)
[![node](https://img.shields.io/node/v/dsh-mcp-lazy.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/dsh-mcp-lazy.svg)](https://github.com/wings1848/dsh-mcp-lazy/blob/main/LICENSE)
[![中文](https://img.shields.io/badge/文档-中文-blue.svg)](https://github.com/wings1848/dsh-mcp-lazy/blob/main/README-zh.md)

A lazy MCP gateway for [DeepSeek Harness](https://github.com/deepseek-ai). It puts **one**
tool in front of the model instead of N MCP tool schemas: servers start on first use, idle
out again, and their tool metadata is cached on disk so `search` and `describe` never spawn
anything.

![One tool instead of N: native registration sends every tool schema on every request and keeps every server resident; dsh-mcp-lazy sends one constant schema and starts servers on first use](https://raw.githubusercontent.com/wings1848/dsh-mcp-lazy/main/docs/assets/how-it-works.svg)

## Why

`@deepseek-ai/dsh-mcp-client` connects every configured server at startup and registers every
one of its tools as a native tool. As its own README puts it, tool descriptions and input
schemas "enter every request while the tools are registered". A handful of servers therefore
costs thousands of tokens on every request and one resident child process each — whether or
not the model ever calls them.

This plugin keeps the model-facing surface at exactly one tool whose schema never changes,
discovers tools on demand from a disk cache, and only spawns a server when a call needs it.

## The numbers

Measured against `chrome-devtools-mcp@1.6.0` (29 tools), both sides rendered the same way —
JSON bytes of the tool definitions, then four bytes per token:

| | per request |
| --- | --- |
| native registration | 21252 bytes ≈ **5313 tokens** |
| this gateway | 1525 bytes ≈ **381 tokens** |
| saved | **92.8%** |

The gateway figure is constant: configuring ten more servers does not move it, because their
schemas are read on demand rather than sent every request.

**The honest counterweight.** The gateway costs a fixed 1525 bytes, so it wins only when a
server's rendered tool definitions exceed that. The bundled fixture offers 7 small tools and
the saving drops to 1.7%. A server with a couple of tiny tools would make the gateway a net
loss. Measure your own before assuming:

```bash
pnpm run measure:savings                                          # local fixture
node scripts/measure-token-savings.mjs --npx <your-server>
```

## Install

```bash
dsh plugin --profile <your-profile> add dsh-mcp-lazy
```

That installs the package into the profile and registers its bundle patch, which inserts the
`mcp-lazy` row. Then give it your servers in the profile's `cordis.patch.yml`:

```yaml
- id: mcp-lazy
  config:
    servers:
      - serverName: chrome
        transport: stdio
        command: npx
        args: ['-y', 'chrome-devtools-mcp@1.6.0']
        lifecycle: lazy
      - serverName: docs
        transport: streamable-http
        url: http://127.0.0.1:3000/mcp
```

Restart the profile. Every field is documented in [docs/configuration.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/docs/configuration.md).

### Moving servers off `@deepseek-ai/dsh-mcp-client`

Every writer of MCP configuration in this ecosystem emits a `@deepseek-ai/dsh-mcp-client` row:
the config-manager panel hardcodes that package name, `@hyzyn/dsh-codegraph` writes a managed
row, and a hand-written config follows the same convention. Such a row registers each MCP tool
as a real tool, so its schemas enter every request — and a server listed in **both** places
cancels the saving this plugin exists for, with no error and nothing to notice. (The `mcp({})`
status output does warn you — for any server the other plugin serves natively, whether or not
this one has it too — which is how you usually find out.)

`adopt` does the move for you:

```bash
dsh-mcp-lazy-adopt                 # dry run: prints the plan, writes nothing
dsh-mcp-lazy-adopt --write         # applies it, with a timestamped backup of each file
```

Or, without leaving the session, as a slash command:

```
/mcp-adopt                         # dry run
/mcp-adopt apply                   # writes
```

The command drives the same CLI, so the plan, the backups and the write are one code path; a
successful `apply` is followed by a re-plan whose result is shown to you, so the answer to "did
it work?" is evidence rather than an assurance. It still requires the human to type it: nothing
runs at plugin startup.

It reads what is *actually* mounted (`dsh --profile <p> --dump-config`, so all four patch layers
are composed), marks each original row `disabled: true` **in place**, and appends the server to
this plugin's `servers` list. Nothing else in the file is touched — comments, blank lines and
`!!js` expressions are preserved byte for byte — and a row it cannot move safely is reported
with a reason instead of being guessed at. Run it while the host is stopped: the web profile
reloads its patch layer live, and `dsh-config-manager` rewrites the same file from its own
state.

**Check the blast radius before you apply.** The native row usually lives in the *home* patch,
which every profile reads, while this plugin's row lives in one profile's patch. Disabling the
former therefore takes that server away from every other profile as well — and those profiles
have no gateway to receive it, so they simply lose the capability. The plan names them:

```
  ⚠ the row being disabled lives in the home layer ~/.dsh/cordis.patch.yml, which every profile reads.
    3 other profile(s) do not mount dsh-mcp-lazy, so they would lose codegraph with no replacement:
    default, dsh-tui, headless.
    Mount dsh-mcp-lazy in those profiles, or move the row into web's own layer, if they need it.
```

If any of them need the server, mount this plugin there too (or move the row) before applying.

A server that does move arrives with only the fields this plugin implements. Two of the other
plugin's fields are **not** implemented here — `reconnect` and `failOnStartupError` — and
carrying them over is an error rather than a no-op, so a row that sets either one is reported as
`unsupported-field` and left exactly where it is: no half-move, and no load failure from a
setting that would look configured and do nothing. A misspelled field name is reported the same
way. The per-row `id` is dropped, because it names the loader row rather than the server.

## What the model sees

One tool, always the same 11 parameters:

```
mcp({ search: "screenshot" })          # find a tool — reads the cache, starts nothing
mcp({ describe: "take_screenshot" })   # full argument schema
mcp({ tool: "take_screenshot" })       # call it — this is what spawns the server
mcp({ tool: "echo", server: "docs" })  # disambiguate a name two servers share
mcp({ connect: "chrome" })             # connect and refresh the cache, without calling
mcp({ instructions: "chrome" })        # the server's own usage notes
mcp({})                                # status: tool count, connection state, cache age
```

Seven of the 11 are the actions above. The other four shape a `search` and are
never needed for anything else:

| Parameter | Meaning | Default | Limit |
| --- | --- | --- | --- |
| `regex` | Treat `search` as a regular expression rather than literal text. | `false` | — |
| `includeSchemas` | Include each match's parameter summary in the result. | `true` | — |
| `limit` | How many matches to return. | `12` | `40`; clamped into 1–40, never an error |
| `offset` | Skip this many matches, for paging through a long result. | `0` | — |

That one tool is the **whole** model-facing surface by default. `directTools` is
the opt-in that promotes chosen server tools into real native tools instead —
see [docs/configuration.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/docs/configuration.md)
for what it accepts, and why the default is the cheap choice.

## Documentation

| | |
| --- | --- |
| [docs/configuration.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/docs/configuration.md) | every field, the four lifecycle modes, output ceiling |
| [docs/troubleshooting.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/docs/troubleshooting.md) | failed servers, cold cache, name resolution |
| [docs/development.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/docs/development.md) | build, test, why `link-dsh` is mandatory |
| [docs/design.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/docs/design.md) | why the plugin is shaped this way: the constant tool surface, the cache, the lifecycle, `envFrom`, and the `adopt` command |
| [docs/parity-pi-mcp-adapter.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/docs/parity-pi-mcp-adapter.md) | module-by-module comparison against `pi-mcp-adapter` v2.33.0, and the defects it turned up |

## Known limitations

The v1 boundary, stated plainly:

- **Tools only.** No MCP resources, prompts, sampling, or elicitation. Only `tools/list_changed`
  is subscribed.
- **No OAuth.** Authentication is a plaintext `headers` entry or an environment variable.
- **Image and audio results are not forwarded.** They are projected to a one-line metadata
  entry (type and byte count). Forwarding pixels needs attachment storage this plugin does
  not implement.
- **No approval gate.** MCP calls follow your DSH permission preset.
- **No config interop.** It reads DSH-native config only; it will not import `.mcp.json`,
  Cursor, Claude Code, Codex, or VS Code server lists.
- **The regex guard is deliberately narrow.** A 256-character cap plus a nested-quantifier
  check, which does **not** catch overlapping alternation like `(a|aa)+` or polynomial
  backtracking like `a*a*a*b`. A full analyser would mean a second runtime dependency.
- **No SSE or unix-socket transports.** `stdio` and `streamable-http` only.
- **`npx` is not resolved to the underlying binary**, so an `npx`-launched server costs one
  extra Node parent process.
- **A secret passed through `args` lands in the child's `argv`**, where `ps` and
  `/proc/<pid>/cmdline` can read it. That path exists only because some servers accept a token
  no other way; `envFrom` alone keeps the value out of `argv`.

## Development

```bash
pnpm install
pnpm test          # builds, relinks the peer packages, runs 388 tests
pnpm run check     # typecheck, lint, build, then type-check the test sources
```

See [CONTRIBUTING.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/CONTRIBUTING.md).

## Star history

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/wings1848/dsh-mcp-lazy/output/star-history-dark.svg">
  <img alt="Star history chart" src="https://raw.githubusercontent.com/wings1848/dsh-mcp-lazy/output/star-history-light.svg">
</picture>

## License

MIT — see [LICENSE](https://github.com/wings1848/dsh-mcp-lazy/blob/main/LICENSE). The connection supervisor, transport factory, and
environment-scrubbing rules derive from `@deepseek-ai/dsh-mcp-client`; the single-proxy-tool
gateway, metadata cache, and weighted search ranking derive from `pi-mcp-adapter`. Both are
MIT; their notices are reproduced in [THIRD_PARTY_NOTICES.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/THIRD_PARTY_NOTICES.md).
