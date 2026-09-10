# dsh-mcp-lazy

Lazy MCP gateway for DeepSeek Harness.

One stable model-facing tool (`mcp`) instead of N MCP tool schemas. Servers connect on
first use, idle out again, and their tool metadata is cached on disk so `search` and
`describe` work without spawning anything.

Measured against `chrome-devtools-mcp@1.6.0` (29 tools): **21252 bytes ≈ 5313 tokens**
of native tool definitions per request becomes **1525 bytes ≈ 381 tokens** — **92.8%
saved**, and that figure is constant no matter how many servers are configured.

中文文档见 [`README.zh.md`](README.zh.md)；实现计划与验收标准见 [`PLAN.md`](PLAN.md).

## Status

Complete and verified: 174 automated tests covering the acceptance criteria in
`PLAN.md`, including real child-process tests for lazy startup, process reuse, idle
reaping, cancellation, timeouts, crash recovery, and live tool-list refresh.

```bash
npm run check                            # typecheck (sources + tests) then build
npm test                                 # 174 tests, ~16s
node scripts/measure-surface.mjs         # the constant per-request cost
node scripts/measure-token-savings.mjs --npx chrome-devtools-mcp@1.6.0 --isolated
```

Server-authored output is bounded too (50 KiB / 2000 lines, then spilled to a temp file
with the path handed back), because the token this plugin saves is a few hundred per
request while a single unbounded tool result can cost tens of thousands — and the harness
does not truncate tool output for you. A failed server is left alone for 60s instead of
being re-spawned on every call, and its stderr tail is folded into the error.

`PARITY.md` records a module-by-module audit against `pi-mcp-adapter` v2.33.0 (28,109
lines of source against this plugin's 3,066), including three defects that audit found and
this plugin has since fixed. Not one of those fixes moved the model-facing tool surface:
it is still 1525 bytes / 11 parameters / 381 tokens.

## Why

`@deepseek-ai/dsh-mcp-client` connects every configured server at startup and registers
every one of its tools as a native tool. The package README states the consequence
plainly: tool descriptions and input schemas "enter every request while the tools are
registered". A handful of servers therefore costs thousands of tokens on every request
and one resident child process each — whether or not the model ever calls them.

This plugin keeps the model-facing surface at exactly one tool whose schema never changes,
discovers tools on demand from a disk cache, and only spawns a server when a call actually
needs it.

## Configuration

```yaml
- id: mcp-lazy
  name: 'dsh-mcp-lazy'
  config:
    idleTimeout: 10          # minutes; 0 disables idle reaping
    outputGuard: true        # bound server output; false to disable, or { maxBytes, maxLines }
    servers:
      - serverName: chrome
        transport: stdio
        command: npx
        args: ['-y', 'chrome-devtools-mcp@1.6.0']
        lifecycle: lazy
      - serverName: docs
        transport: streamable-http
        url: http://127.0.0.1:3000/mcp
        directTools: search
      - serverName: broken
        transport: stdio
        command: some-server
        debug: false         # true forwards the child's stderr to your terminal
```

Migrating from `@deepseek-ai/dsh-mcp-client`: move each row's `config` into one entry of
`servers` and drop the per-row `id`. The transport fields keep their meaning.

## License

MIT. The connection, transport, and environment-scrubbing design is derived from
`@deepseek-ai/dsh-mcp-client` (MIT, Copyright (c) 2026 DeepSeek); the lazy gateway,
metadata cache, and search ranking are derived from `pi-mcp-adapter` (MIT,
Copyright (c) Nico Bailon). See `LICENSE`.
