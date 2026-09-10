## What this changes

<!-- One or two sentences. What is different after this PR? -->

## Why

<!--
The reason, not the diff. If this fixes a bug, what was the wrong behaviour and
what was the user-visible consequence? If it is a feature, what could you not do
before?
-->

## Checklist

- [ ] `pnpm run check` passes
- [ ] `pnpm test` passes
- [ ] A bug fix comes with a test that was **observed to fail before the fix**.
      Say below how you confirmed the failure — a test that has never been red
      may be passing for the wrong reason.
- [ ] If anything the model sees changed, `node scripts/measure-surface.mjs` was
      re-run and the new numbers are quoted below.
- [ ] No credentials, tokens, or private URLs in the diff or in the config
      examples.

## Model-facing surface

<!--
Only if this PR touches it. The whole point of the plugin is that this stays
constant: one tool, 11 parameters, 1525 bytes. Quote the before and after.
-->

```
before:
after:
```

## How this was verified

<!--
Commands you ran and what they printed. If you tested against a real MCP server,
name it — a check against a real server is worth more than one against the
fixture.
-->
