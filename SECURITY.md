# Security Policy

## Supported versions

Only the latest released version of `dsh-mcp-lazy` is supported with security
fixes. `package.json` is the source of truth for which version that is; this file
does not repeat the number, because it has been out of date before.

## Reporting a vulnerability

Use GitHub private security advisories:

**https://github.com/wings1848/dsh-mcp-lazy/security/advisories/new**

Please do not open a public issue, pull request, or discussion for a suspected
vulnerability. A public report before a fix exists puts every user of the plugin
at risk.

Include:

- the affected version (the `version` field of the installed `package.json`);
- a reproduction: the relevant configuration, the steps, and what happens;
- the impact: what an attacker gains, and what they must already control
  (the configuration file, a configured MCP server, the model's tool arguments,
  or something else).

## Response targets

This is a single-maintainer project maintained in spare time. The values below
are targets, not guarantees:

- acknowledgement of a report: within 7 days;
- an assessment (confirmed, or not a vulnerability, with reasoning): within
  30 days of acknowledgement;
- a fix, a documented mitigation, or an agreed disclosure: within 90 days of
  acknowledgement.

If a report is confirmed, you will be credited in the advisory unless you ask
otherwise. Please allow a reasonable window for a fix before disclosing publicly.

## Security model

`dsh-mcp-lazy` runs inside the harness process and bridges to MCP servers. This
section describes what the code actually does. The project has **not** been
independently audited, and nothing here is a guarantee.

### Configuration is trusted input

For `stdio` servers, `command`, `args`, `env`, `envFrom`, and `cwd` come straight
from the plugin configuration (`src/index.ts` config schema, `src/connection.ts`
`#createTransport`, `src/env-from.ts`). The child is spawned with those values.
Configuring a malicious `command` — or an `envFrom` command that does something
other than print a secret — is exactly equivalent to running that command
yourself, and the plugin cannot tell the difference. Configuration validation at
load only rejects entries that cannot work at all: a duplicate `serverName`,
`stdio` without `command`, `streamable-http` without `url`, and four `envFrom`
mistakes (`src/index.ts` `assertEnvFrom`).

The model does not get to choose the command. The proxy tool's parameters are
`search`, `describe`, `tool`, `args`, `server`, `connect`, `instructions`,
`regex`, `includeSchemas`, `limit`, and `offset` (`src/schema.ts`) — there is no
parameter that names a program. Prompt injection through a server can therefore
choose *which* configured tool runs and with what arguments, but it cannot make
the plugin spawn something that is not in your configuration.

No sandboxing is applied anywhere in the plugin: no container, no user switch, no
filesystem confinement. An MCP server runs with the same privileges as the
harness process, and it can do anything that user can do.

For `streamable-http` servers, `url` and `headers` are used verbatim
(`src/connection.ts`). The URL is not required to be HTTPS and is not restricted
to localhost; validation only checks that it is non-empty (`src/index.ts`). Header
values, such as a bearer token, are stored in plain text in the DSH configuration.
There is no credential store and no OAuth support (`README-zh.md`).

### Child process environment

Every stdio child starts from `scrubbedParentEnv()` from the
`@deepseek-ai/dsh-subprocess` peer package, used in `src/connection.ts`. It drops:

- every variable whose **name** matches `/KEY|PASSWORD|SECRET|TOKEN/i`
  (case-insensitive), so `DEEPSEEK_API_KEY`, `GITHUB_TOKEN`, and `DB_PASSWORD`
  do not reach the child;
- every variable whose name, upper-cased, starts with `DSH_`;
- variables with an undefined value.

`PATH`, `HOME`, locale, and proxy variables survive, so child CLIs keep working.
A proxy configuration is re-applied to the child so it routes the same way the
harness does.

The entry's explicit `env` is merged on top of the scrub
(`src/connection.ts`), so a value you configure deliberately does survive — that
is the intended escape hatch. `envFrom` is the other one: each declared name is
resolved by running its command at spawn time, and the result is merged on top of
both the scrub and `env`. A server that needs `GITHUB_TOKEN` will not start unless
you put it in `env` or resolve it through `envFrom`; that is a migration trap when
coming from plugins that inherit the whole environment, not a bug.

What `envFrom` adds to the trust model, and what it does not:

- **The commands are configuration, so they are trusted input** in exactly the
  sense above. They run through `/bin/sh -c` with the harness's privileges and the
  scrubbed environment — not the entry's `env`, so a command cannot read a
  credential that only the entry was given (`src/env-from.ts`).
- **Values do not go anywhere else.** The result is never written back to the
  entry, so it is absent from `cache.json`, from logs, and from the host's own
  environment; a diagnostic carries the variable name, the exit code, and up to
  2 000 characters of the command's stderr — never its stdout
  (`src/env-from.ts`, `src/connection.ts`).
- **A failure refuses to start the server** rather than injecting an empty value,
  which is the point of the feature (`src/env-from.ts`).
- **A value interpolated into `args` is visible to `ps`** and in
  `/proc/<pid>/cmdline` on the same machine. That is a property of the child's
  `argv`, not of this plugin; `envFrom` alone keeps the value out of it.

This scrub is a boundary against accidental leakage of ambient credentials, not
against the model: the model cannot edit configuration.

### Regular expressions from the model

`mcp({ search, regex: true })` takes a pattern from the model and evaluates it
with `new RegExp(pattern, 'i')`. Two guards are applied first, both in
`src/search-ranking.ts`:

- a length cap of 256 characters (`MAX_REGEX_QUERY_LENGTH`);
- a structural check for an unbounded quantifier nested inside an unboundedly
  quantified group, which rejects shapes such as `(a+)+`, `(a*)*`, and
  `(a{2,})+`.

This is deliberately narrower than a full ReDoS analyser, and the limitation is
documented in the code rather than implied. It does **not** catch overlapping
alternation such as `(a|aa)+`, nor polynomial backtracking such as `a*a*a*b`.
`pi-mcp-adapter` runs the `recheck` analyser here; this plugin keeps its single
runtime dependency (`package.json`) and accepts the narrower guarantee.

The consequence is concrete: pattern evaluation is synchronous inside the tool
call (`src/search-ranking.ts` `regexToolMatches`, called from `src/registry.ts`),
so an accepted-but-pathological pattern blocks the event loop and stalls the
session — this was measured at roughly 2 seconds for one 28-character input
before the guard existed (`docs/parity-pi-mcp-adapter.md` §5.3). Rejected
patterns are returned as values with the reason shown to the model, not thrown.

### Spilled output files

When server-authored text exceeds the inline ceilings (50 KiB or 2000 lines by
default), the head is returned and the full text is written to disk
(`src/output-guard.ts`):

- the directory is created with
  `mkdtemp(join(tmpdir(), 'dsh-mcp-lazy-output-'))` — a fresh per-process
  directory under the system temp directory, whose name carries the
  `dsh-mcp-lazy-output-` prefix and a random suffix;
- the file is `output-<8 hex characters>.txt`, written with mode `0o600`, so only
  the owning user can read it;
- a single spill file is capped at 16 MiB (`MAX_SPILL_BYTES`);
- the directories created by the guard are removed when the plugin unloads
  (`OutputGuard.dispose`, wired through `ctx.effect` in `src/index.ts`).

The path is disclosed to the model in the tool result. If the process dies before
an orderly unload, the files remain under the system temp directory for the
operating system to reap. Files are only created when something actually exceeds
the ceilings, and the guard applies only to server-authored payloads — tool
results, `describe` schemas, and server instructions; the gateway's own status,
search, and error text is bounded by construction.

### Server-authored content

Tool names, descriptions, schemas, server instructions, and tool results come from
the MCP server and are passed to the model (`src/connection.ts`
`projectToolResult`, `src/registry.ts`). A malicious or compromised server can
therefore put arbitrary text into the model's context, including text that looks
like instructions. Treat an MCP server as you would any other program you run.

Image and audio blocks are projected to a type and a byte count; the payload
itself is not forwarded, so a server cannot push binary data into the context
(`src/connection.ts` `projectBlock`).

### Local files written by the plugin

The plugin writes in exactly two places (`src/metadata-cache.ts`,
`src/output-guard.ts`):

- `$DSH_HOME/storages/mcp-lazy/cache.json` (or `~/.dsh/...` when `DSH_HOME` is
  unset) holds tool names, descriptions, schemas, and server instructions, plus a
  SHA-256 digest of the transport configuration. The digest covers `env`,
  `headers`, and any `envFrom` commands — the commands, never their results, and
  the field is left out of the digest entirely when nothing is declared, so an
  entry that does not use it keeps its existing digest. The values are not stored.
  The file is written atomically (temporary file plus rename) with no explicit
  mode, so it follows your process umask — unlike the spill files;
- the spill files described above.

The plugin opens no listening socket and makes no network requests other than to
the MCP servers you configure. Its only `node:` imports are `child_process`,
`crypto`, `fs`, `fs/promises`, `os`, `path`, and `url`
(`rg -oN "from 'node:[^']+'" src/ | sort -u`).

`child_process` is what runs an `envFrom` command and the MCP server itself; a
command you configure is free to reach the network, exactly as a server's own
`command` is.

### Scope note

The plugin's own code ships as `lib/` in the npm tarball and is also rebuilt from
`src/` on `prepack` (`package.json` `files`, `scripts`). The `@deepseek-ai/*`
peer packages are supplied by the harness, not by this package; vulnerabilities
in the harness or in the MCP SDK belong in their respective projects, though a
report here that involves this plugin's use of them is still welcome.
