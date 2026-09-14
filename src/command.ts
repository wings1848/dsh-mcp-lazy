/**
 * The `/mcp-adopt` human command.
 *
 * The `adopt` CLI moves servers that `@deepseek-ai/dsh-mcp-client` registers
 * natively into this plugin's own `servers` list, and disables the native row in
 * place. Until this module existed that was a terminal errand: stop the host, run
 * `npx dsh-mcp-lazy-adopt --write`, start it again. The status listing already
 * told the user the move was needed (see `renderStatus`'s conflict block); this
 * closes the gap between being told and being able to act.
 *
 * Three properties are load-bearing, and each one is a deliberate choice:
 *
 * - **The command is reached through an optional injection.** Declaring
 *   `commands` in the plugin's own `inject` would make the entire MCP gateway
 *   wait for a command registry that some compositions never mount, so the tool
 *   the plugin exists to provide would silently never register. `ctx.inject`
 *   opens a child fiber instead and leaves activation alone.
 * - **The default is a dry run.** A bare `/mcp-adopt` reaches the CLI without
 *   `--write`; only an explicit `apply` may write. The CLI's own contract is the
 *   same, and this command must not loosen it.
 * - **The work itself is delegated, never reimplemented.** The planner, the
 *   byte-preserving text edits, the backups, the digest re-check and the
 *   tmp+rename write all live in `scripts/adopt.mjs`, which ships with this
 *   package. A second implementation here would be a second thing to keep in
 *   step, and the write path is the one place where drift is unrecoverable.
 *
 * @module dsh-mcp-lazy/command
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

/** The name this command is registered under, without the leading slash. */
export const ADOPT_COMMAND_NAME = 'mcp-adopt'

/**
 * The slice of `@deepseek-ai/dsh-commands` this plugin uses.
 *
 * Declared structurally rather than imported: the package is only ever reached
 * through the injected service, the import would be type-only, and adding it as a
 * peer dependency would state a runtime requirement this plugin does not have.
 * The shape is verified upstream at `dsh-commands/lib/types/index.d.ts` and
 * `types.d.ts`; the registry refuses a definition that does not match it.
 */
export type CommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/** The invocation fields this command reads. */
export interface CommandInvocationLike {
  /** Exact text following the command name, separator whitespace included. */
  readonly rawInput: string
  /** Cancellation signal owned by the dispatching UI request. */
  readonly signal?: AbortSignal
}

/** One plugin-owned command registration. */
export interface CommandDefinitionLike {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string; readonly attachments?: boolean }
  readonly handler: (invocation: CommandInvocationLike) => CommandResult | Promise<CommandResult>
}

/** The command registry this plugin registers into, when one is mounted. */
export interface CommandsLike {
  register: (definition: CommandDefinitionLike) => () => void
}

/** The settled outcome of one CLI run. */
export interface AdoptRun {
  /** Process exit code, or `null` when it died on a signal. */
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  /** Set when the process could not be started at all (ENOENT, EACCES, …). */
  readonly failure?: string
}

/** Injectable seams. Every one has a production default. */
export interface AdoptCommandDeps {
  /** Absolute path of the shipped CLI. Defaults to `../scripts/adopt.mjs`. */
  readonly scriptPath?: string
  /** Profile and home for the running host. Defaults to the pair derived from `ctx.baseUrl`. */
  readonly profile?: (ctx: Context) => HostProfile | undefined
  /** Run the CLI. Defaults to an asynchronous spawn of `process.execPath`. */
  readonly run?: (args: readonly string[], signal?: AbortSignal) => Promise<AdoptRun>
  /** How long one CLI run may take before it is killed. Defaults to two minutes. */
  readonly timeoutMs?: number
}

/** Which profile the host is running, and which home it belongs to. */
export interface HostProfile {
  /** Absolute `$DSH_HOME`. */
  readonly home: string
  /** Profile name — the directory under `<home>/profiles`. */
  readonly name: string
}

/** What the command accepts after its name. */
const USAGE = 'Usage: /mcp-adopt [apply] — no argument shows the plan, `apply` writes it.'

/** Where the shipped CLI lives, relative to this compiled module. */
const DEFAULT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'adopt.mjs')

/** A CLI run that has not answered in this long is treated as failed rather than awaited forever. */
const DEFAULT_TIMEOUT_MS = 120_000

/**
 * The parsed input line, or `undefined` when it is not something this command does.
 *
 * Only two inputs exist. Anything else is refused rather than interpreted: the
 * one thing this command must never do is guess its way into a write.
 *
 * @param rawInput - The text following the command name.
 * @returns Whether to write, or `undefined` for an unrecognised input.
 */
function parseInput(rawInput: string): { write: boolean } | undefined {
  const input = rawInput.trim()
  if (input === '') return { write: false }
  if (input.toLowerCase() === 'apply') return { write: true }
  return undefined
}

/**
 * The profile this host was booted with, derived from `ctx.baseUrl`.
 *
 * `DSH_PROFILE` does not exist, and `DSH_HOME` is not reliably in the host
 * process environment either — the harness injects that for tool subprocesses,
 * not for itself. So the profile is recovered from the one fact that is
 * guaranteed: `ctx.baseUrl` is `<home>/profiles/<name>`, set by the boot from
 * the directory holding the profile's root config. Both halves are then passed
 * to the CLI explicitly, so the two sides agree by construction instead of each
 * resolving a home of its own.
 *
 * A path that is not `<something>/profiles/<name>` is refused rather than
 * returned: writing another profile's configuration is not recoverable by
 * re-running anything, so this refuses instead of guessing.
 *
 * @param ctx - The plugin context.
 * @returns The home and profile name, or `undefined` when they cannot be established.
 */
function profileFromBaseUrl(ctx: Context): HostProfile | undefined {
  const holder = ctx as unknown as { baseUrl?: unknown; root?: { baseUrl?: unknown } }
  const baseUrl = holder.baseUrl ?? holder.root?.baseUrl
  if (typeof baseUrl !== 'string' || baseUrl === '') return undefined

  let directory: string
  try {
    directory = fileURLToPath(baseUrl)
  } catch {
    return undefined
  }

  const profileDir = directory.replace(/[/\\]+$/u, '')
  const name = basename(profileDir)
  const profilesDir = dirname(profileDir)
  if (name === '' || name === '.' || name === '..') return undefined
  if (basename(profilesDir) !== 'profiles') return undefined
  const home = dirname(profilesDir)
  if (home === '' || home === '/') return undefined
  return existsSync(profileDir) ? { home, name } : undefined
}

/** A one-line description of a thrown value. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message === '' ? error.name : error.message
  return String(error)
}

/** The message a run that outlives its budget produces, whoever implemented the runner. */
function timeoutMessage(timeoutMs: number): string {
  return `the adopt CLI did not finish within ${String(timeoutMs)}ms and was stopped`
}

/**
 * Bound one CLI run, whatever runner is behind it.
 *
 * The default runner already kills its child on the same budget; this is the
 * guarantee that does not depend on that. A command handler that never settles
 * leaves the UI spinning with nothing to show for it, and unlike a promise
 * rejection there is no later opportunity to notice — so the deadline lives at
 * the seam the handler awaits, not inside one implementation of it.
 *
 * @param pending - The run in flight.
 * @param timeoutMs - How long it may take.
 * @returns The run's outcome.
 * @throws When the budget runs out.
 */
async function withTimeout(pending: Promise<AdoptRun>, timeoutMs: number): Promise<AdoptRun> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(timeoutMessage(timeoutMs)))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The default runner: an asynchronous spawn of the shipped CLI.
 *
 * Asynchronous on purpose. The CLI itself spawns a `dsh --profile <p>
 * --dump-config` child, which takes seconds; `spawnSync` would hold the host's
 * event loop for that whole time and freeze every other plugin.
 *
 * Bounded too. A `dsh --dump-config` that hangs — a wedged filesystem, a home on
 * a stalled network mount — would otherwise leave the command pending forever and
 * the GUI spinning with it. The CLI's own inner spawn is unbounded, so the bound
 * has to live here.
 *
 * @param script - Absolute path of the CLI.
 * @param timeoutMs - How long the child may run before it is killed.
 * @returns A function that runs it and collects both streams.
 */
function spawnRunner(
  script: string,
  timeoutMs: number,
): (args: readonly string[], signal?: AbortSignal) => Promise<AdoptRun> {
  return (args, signal) =>
    new Promise<AdoptRun>(resolve => {
      let stdout = ''
      let stderr = ''
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const settle = (outcome: AdoptRun): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        resolve(outcome)
      }

      const child = spawn(process.execPath, [script, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(signal === undefined ? {} : { signal }),
      })
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk
      })
      child.on('error', (error: Error) => {
        settle({ status: null, stdout, stderr, failure: describe(error) })
      })
      child.on('close', (code: number | null) => {
        settle({ status: code, stdout, stderr })
      })

      timer = setTimeout(() => {
        child.kill('SIGTERM')
        settle({
          status: null,
          stdout,
          stderr,
          failure: timeoutMessage(timeoutMs),
        })
      }, timeoutMs)
    })
}

/**
 * Translate a partial move into text the UI can render.
 *
 * The CLI writes before it reports skips, so exit 1 means "some of this landed".
 * The wording says so explicitly, because the alternative reading — nothing
 * happened — would send the reader looking for a problem that is not there.
 *
 * @param outcome - The finished run.
 * @returns The command result text.
 */
function partialMove(outcome: AdoptRun): string {
  const sections = [
    '⚠ Some rows were skipped. The rest of the plan was applied — this command writes before it',
    'reports skips — so running it again shows what is left and why.',
    '',
    outcome.stdout.trimEnd(),
  ]
  const stderr = outcome.stderr.trim()
  if (stderr !== '') sections.push('', stderr)
  return sections.join('\n')
}

/**
 * Translate a failed run into text the UI can render.
 *
 * @param outcome - The finished run.
 * @returns The command result text.
 */
function failureText(outcome: AdoptRun): string {
  const stderr = outcome.stderr.trim()
  const stdout = outcome.stdout.trim()
  const detail = stderr !== '' ? stderr : stdout
  const reason =
    outcome.failure ?? `the CLI exited with code ${String(outcome.status)} (2 means an environment error)`
  return detail === '' ? reason : `${reason}\n\n${detail}`
}

/** The one line of the CLI's plan output that says how much work there is. */
const PLAN_SUMMARY = /^\d+ server\(s\) to move,.*$/mu

/**
 * Re-plan after a write, so a successful result carries evidence rather than an
 * assurance.
 *
 * The command cannot report what the host did with the file — the patch layer
 * reloads on its own schedule — but it can report what the file now says, by
 * asking the same CLI to plan again. That is the difference between "written"
 * and "written, and here is what a fresh plan makes of it".
 *
 * @param run - The CLI runner.
 * @param base - The arguments that identify the profile, without `--write`.
 * @returns One line describing the re-check, or why it could not be made.
 */
async function verifyWrite(
  run: (args: readonly string[], signal?: AbortSignal) => Promise<AdoptRun>,
  base: readonly string[],
  timeoutMs: number,
): Promise<string> {
  let recheck: AdoptRun
  try {
    recheck = await withTimeout(run(base), timeoutMs)
  } catch (error) {
    return `Could not re-plan to confirm the write: ${describe(error)}`
  }
  if (recheck.failure !== undefined) {
    return `Could not re-plan to confirm the write: ${recheck.failure}`
  }
  const summary = PLAN_SUMMARY.exec(recheck.stdout)?.[0]
  if (summary === undefined) {
    const seen = recheck.stdout.trim() === '' ? recheck.stderr.trim() : recheck.stdout.trim()
    return `Could not re-plan to confirm the write: the CLI printed no summary line.\n${seen}`
  }
  return /^0 server\(s\) to move/u.test(summary)
    ? `Confirmed by re-planning: ${summary}`
    : `⚠ Re-planning still reports work to do — ${summary}`
}

/**
 * Register `/mcp-adopt` on the host's command registry, if there is one.
 *
 * The registration rides a child fiber opened by `ctx.inject`, so it appears
 * whenever the service does and disappears with the plugin's own scope. The
 * plugin's `inject` list is deliberately left at `['tools']`.
 *
 * @param ctx - The plugin context.
 * @param deps - Test seams; production passes nothing.
 */
export function registerAdoptCommand(ctx: Context, deps: AdoptCommandDeps = {}): void {
  ctx.inject(['commands'], (commandCtx: Context) => {
    const registry = (commandCtx as unknown as { commands?: CommandsLike }).commands
    if (registry === undefined || typeof registry.register !== 'function') return

    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const run =
      deps.run ?? spawnRunner(deps.scriptPath ?? DEFAULT_SCRIPT, timeoutMs)
    const profileOf = deps.profile ?? profileFromBaseUrl

    registry.register({
      name: ADOPT_COMMAND_NAME,
      description:
        'Move servers registered by @deepseek-ai/dsh-mcp-client into this lazy gateway (dry run unless you pass apply)',
      input: { hint: '[apply]' },
      handler: async (invocation: CommandInvocationLike): Promise<CommandResult> => {
        const parsed = parseInput(invocation.rawInput)
        if (parsed === undefined) {
          return { kind: 'error', text: `That is not something /${ADOPT_COMMAND_NAME} does. ${USAGE}` }
        }

        const host = profileOf(ctx)
        if (host === undefined) {
          return {
            kind: 'error',
            text:
              `Cannot tell which profile this host is running, and guessing could write another ` +
              `profile's configuration. Run the CLI directly instead: npx dsh-mcp-lazy-adopt --profile <name>`,
          }
        }

        const base = ['--profile', host.name, '--dsh-home', host.home]
        // A cancelled dry run costs nothing. A cancelled *write* can stop between
        // the CLI's two file renames — the native row disabled, its replacement
        // not yet adopted — so the write phase is deliberately not cancellable.
        const signal = parsed.write ? undefined : invocation.signal

        let outcome: AdoptRun
        try {
          outcome = await withTimeout(
            run(parsed.write ? [...base, '--write'] : base, signal),
            timeoutMs,
          )
        } catch (error) {
          return {
            kind: 'error',
            text: `Running the adopt CLI failed: ${describe(error)}`,
          }
        }

        if (outcome.failure !== undefined) return { kind: 'error', text: failureText(outcome) }
        if (outcome.status === 1) return { kind: 'success', text: partialMove(outcome) }
        if (outcome.status !== 0) return { kind: 'error', text: failureText(outcome) }
        if (!parsed.write) return { kind: 'success', text: outcome.stdout }

        const evidence = await verifyWrite(run, base, timeoutMs)
        return { kind: 'success', text: `${outcome.stdout.trimEnd()}\n\n${evidence}` }
      },
    })
  })
}
