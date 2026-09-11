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

Migrating from `@deepseek-ai/dsh-mcp-client`: move each row's `config` into one entry of
`servers` and drop the per-row `id`. The transport fields keep their meaning.

Two of that plugin's fields are **not** implemented here — `reconnect` and `failOnStartupError`
— and carrying them over is an error rather than a no-op, so the load fails with an
explanation instead of leaving a setting that looks configured and does nothing. The same
applies to a misspelled field name.

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

## Documentation

| | |
| --- | --- |
| [docs/configuration.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/docs/configuration.md) | every field, the four lifecycle modes, output ceiling |
| [docs/troubleshooting.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/docs/troubleshooting.md) | failed servers, cold cache, name resolution |
| [docs/development.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/docs/development.md) | build, test, why `link-dsh` is mandatory |
| [docs/design/plan.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/docs/design/plan.md) | implementation plan and acceptance criteria |
| [docs/design/parity-pi-mcp-adapter.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/docs/design/parity-pi-mcp-adapter.md) | module-by-module audit against `pi-mcp-adapter` v2.33.0 |

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

## Development

```bash
pnpm install
pnpm test          # builds, relinks the peer packages, runs 195 tests
pnpm run check     # typecheck (sources and tests) then build
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
