/**
 * `envFrom`: a server's secrets, resolved by running a command.
 *
 * The plugin's `env` field is a static dictionary in a YAML file, so it cannot
 * ask a secret manager for anything. A `!!js` expression can, but it is
 * evaluated once when the host loads its configuration — a key rotated
 * afterwards needs a host restart, and a locked vault at boot poisons the whole
 * process. `envFrom` moves the lookup to the moment the server is spawned,
 * which is the only moment that is both late enough to see a rotated value and
 * early enough to fail loudly.
 *
 * Three properties are enforced here rather than hoped for:
 *
 * - **A failure is never an empty value.** A non-zero exit, a timeout, and an
 *   empty result all refuse to start the server, because a server that boots
 *   with a blank key fails later, somewhere less readable, or not at all.
 * - **The command's stdout never reaches a message.** Diagnostics carry the
 *   variable name, the exit code, and the command's own stderr — never the
 *   value, which is what makes it safe for these errors to be shown to a model.
 * - **A timeout leaves nothing behind.** Commands run in their own process
 *   group, and a timeout sends `SIGTERM` and then `SIGKILL` a second later —
 *   the escalation stays armed even after the group's leader exits, because a
 *   member that ignores the polite signal outlives its parent.
 *
 * @module dsh-mcp-lazy/env-from
 */

import { spawn } from 'node:child_process'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { ServerEntry } from './types.js'

/** How long one command gets before it is treated as hung. */
export const DEFAULT_ENV_FROM_TIMEOUT_MS = 10_000

/**
 * How long a command gets to die on `SIGTERM` before it is killed outright.
 *
 * Credential tools that wait on a prompt (`op`, `rbw`, `pass` with a locked
 * GPG key) can ignore a polite request — some install a handler, some block in
 * a child — and without the escalation a timeout would leave exactly the
 * half-dead process it was meant to prevent.
 */
export const ENV_FROM_KILL_GRACE_MS = 1_000

/** How much of a command's stderr an error message keeps. */
export const ENV_FROM_STDERR_LIMIT = 2_000

/** Upper bound on one command's stdout, so a runaway cannot exhaust memory. */
const ENV_FROM_STDOUT_LIMIT = 64 * 1024

/**
 * `{{NAME}}` in an argument.
 *
 * The name half is deliberately wider than a POSIX identifier: `envFrom` keys
 * are arbitrary strings as far as the schema is concerned, and a placeholder
 * that silently fails to substitute because the name contains a dash would be
 * the kind of quiet mismatch this plugin exists to avoid. Only declared names
 * are replaced, so widening the pattern cannot turn a legitimate template
 * argument into a value; anything undeclared is left exactly as written.
 */
const PLACEHOLDER = /\{\{([^\s{}]+)\}\}/g

/** Raised when a command cannot produce a value. */
export class EnvFromError extends Error {
  /**
   * @param message - Human-readable explanation; never contains a value.
   */
  constructor(message: string) {
    super(message)
    this.name = 'EnvFromError'
  }
}

/** Overrides for {@link resolveEnvFrom}. */
export interface EnvFromOptions {
  /** Wall-clock budget per command, in milliseconds. */
  timeoutMs?: number
  /** Variable names whose empty result is accepted rather than refused. */
  allowEmpty?: readonly string[]
}

/** What one command produced. */
interface CommandOutcome {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  /** Whether stdout hit {@link ENV_FROM_STDOUT_LIMIT} and was cut short. */
  stdoutOverflow: boolean
}

/**
 * Append a chunk without letting the result pass a cap.
 *
 * Appending first and slicing is the whole point: one pipe chunk can be 64 KiB,
 * so testing the accumulated length *before* appending lets a single chunk
 * carry the string far past the limit — which is exactly how a "2 KB" stderr
 * cap produced a 65 KB error message.
 *
 * @param current - What has been kept so far.
 * @param chunk - The chunk just read.
 * @param limit - The most that may be kept.
 * @returns The new accumulated string, never longer than the limit.
 */
function appendCapped(current: string, chunk: string, limit: number): string {
  if (current.length >= limit) return current
  return current + chunk.slice(0, limit - current.length)
}

/**
 * Kill a command and everything it started.
 *
 * Commands are spawned detached, so the child is a process-group leader and
 * `-pid` addresses the whole group. Killing only the shell would leave a
 * pipeline's other stages running.
 *
 * @param pid - The child's pid.
 * @param signal - Which signal to send.
 */
function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
  } catch {
    // No process group (the spawn never detached, or the group is already
    // gone). Fall back to the child itself, which may still be alive.
    try {
      process.kill(pid, signal)
    } catch {
      // Already gone: nothing to kill, and nothing to report.
    }
  }
}

/**
 * Run one `envFrom` command and collect its output.
 *
 * Asynchronous on purpose: `spawnSync` would hold the host's event loop for the
 * whole budget, freezing every other plugin behind a key lookup.
 *
 * @param command - Command line handed to `/bin/sh -c`.
 * @param timeoutMs - Wall-clock budget before the process group is killed.
 * @returns The command's output and how it ended.
 */
function runCommand(command: string, timeoutMs: number): Promise<CommandOutcome> {
  return new Promise<CommandOutcome>((resolve, reject) => {
    let child
    try {
      child = spawn('/bin/sh', ['-c', command], {
        // The same baseline the MCP child gets: credential-shaped and `DSH_*`
        // names are dropped, so a command cannot read a secret the server it
        // belongs to was not allowed to see.
        env: scrubbedParentEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
    } catch (error) {
      reject(new EnvFromError(`could not start the command: ${String(error)}`))
      return
    }

    let stdout = ''
    let stderr = ''
    let stdoutOverflow = false
    let timedOut = false
    let settled = false
    let leaderExited = false
    let leaderCode: number | null = null
    let killTimer: ReturnType<typeof setTimeout> | undefined

    const settle = (outcome: CommandOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // `killTimer` is deliberately *not* cleared. `close` means the leader is
      // gone, not that its process group is empty: a member that ignores
      // `SIGTERM` outlives it, and cancelling the escalation here is exactly
      // what let one survive a timeout forever. The timer is unref'd, and its
      // kill is a no-op once the group is empty.
      resolve(outcome)
    }

    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child.pid, 'SIGTERM')
      killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), ENV_FROM_KILL_GRACE_MS)
      // The escalation must not be the reason the host stays alive.
      killTimer.unref?.()
      // The leader can be gone while its output streams stay open, because a
      // background child still holds the pipe and `close` waits for EOF. When
      // it exited successfully, the budget did not run out on *it*: kill the
      // rest of the group so the pipe closes, and report what it produced.
      if (leaderExited && leaderCode === 0) {
        settle({ stdout, stderr, exitCode: 0, timedOut: false, stdoutOverflow })
      }
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk)
      if (stdout.length + text.length > ENV_FROM_STDOUT_LIMIT) stdoutOverflow = true
      stdout = appendCapped(stdout, text, ENV_FROM_STDOUT_LIMIT)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = appendCapped(stderr, String(chunk), ENV_FROM_STDERR_LIMIT)
    })
    child.on('error', (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      reject(new EnvFromError(`could not start the command: ${error.message}`))
    })
    // Tracked separately from `close`, which also waits for the pipes: the two
    // answer different questions, and the timeout path needs this one.
    child.on('exit', (code: number | null) => {
      leaderExited = true
      leaderCode = code
    })
    child.on('close', (code: number | null) => {
      settle({ stdout, stderr, exitCode: code, timedOut, stdoutOverflow })
    })
  })
}

/**
 * Turn one command's outcome into a value, or into a refusal to start.
 *
 * @param name - Variable name, for the diagnostic.
 * @param command - The command line.
 * @param timeoutMs - Its budget.
 * @param allowEmpty - Whether an empty result is acceptable for this name.
 * @returns The trimmed value.
 * @throws {EnvFromError} When no value can be trusted.
 */
async function resolveOne(
  name: string,
  command: string,
  timeoutMs: number,
  allowEmpty: boolean,
): Promise<string> {
  let outcome: CommandOutcome
  try {
    outcome = await runCommand(command, timeoutMs)
  } catch (error) {
    // A command that could not even be started reports the variable name too:
    // "could not start the command" without one leaves the reader to guess
    // which declaration in a list of five is the broken one.
    const detail = error instanceof Error ? error.message : String(error)
    throw new EnvFromError(`envFrom: "${name}" could not be run — ${detail}`)
  }

  if (outcome.timedOut) {
    throw new EnvFromError(
      `envFrom: "${name}" did not finish within ${timeoutMs} ms and was killed — ` +
        'raise envFromTimeoutMs if the command legitimately takes longer',
    )
  }
  if (outcome.exitCode !== 0) {
    const detail = outcome.stderr.trim()
    const code = `exit ${outcome.exitCode ?? 'null'}`
    throw new EnvFromError(
      `envFrom: "${name}" failed (${code})${detail === '' ? '' : `: ${detail}`}`,
    )
  }
  if (outcome.stdoutOverflow) {
    // Refused rather than truncated: a value cut off at the cap is a wrong
    // secret that would fail somewhere else, much less legibly.
    throw new EnvFromError(
      `envFrom: "${name}" printed more than ${ENV_FROM_STDOUT_LIMIT} characters — ` +
        'too much for a value; make the command print only the secret',
    )
  }

  // Only the surrounding whitespace is stripped: a secret may contain any other
  // character, and guessing further would corrupt it.
  const value = outcome.stdout.trim()
  if (value.includes('\u0000')) {
    // Refused before it reaches `spawn`, whose own error message quotes the
    // offending value verbatim — which would put it in `lastError` and from
    // there in front of the model.
    throw new EnvFromError(
      `envFrom: "${name}" produced a NUL byte, which no environment value may contain`,
    )
  }
  if (value === '' && !allowEmpty) {
    throw new EnvFromError(
      `envFrom: "${name}" produced no output — the command ran but printed nothing. ` +
        `List the name in allowEmpty if an empty value is genuinely correct.`,
    )
  }
  return value
}

/**
 * Resolve every `envFrom` declaration for one server entry.
 *
 * All commands run concurrently, and the call settles only once every one of
 * them has: returning on the first failure would leave the others' process
 * groups running with nobody left to reap them.
 *
 * @param entry - The configured server entry.
 * @param options - Overrides, used by tests.
 * @returns One value per declared name; empty when nothing was declared.
 * @throws {EnvFromError} When any command fails to produce a trustworthy value.
 */
export async function resolveEnvFrom(
  entry: ServerEntry,
  options: EnvFromOptions = {},
): Promise<Record<string, string>> {
  const commands = entry.envFrom ?? {}
  const names = Object.keys(commands)
  if (names.length === 0) return {}

  const timeoutMs = options.timeoutMs ?? entry.envFromTimeoutMs ?? DEFAULT_ENV_FROM_TIMEOUT_MS
  const allowEmpty = new Set(options.allowEmpty ?? entry.allowEmpty ?? [])

  const settled = await Promise.allSettled(
    names.map(async name => {
      const command = commands[name]
      if (command === undefined) throw new EnvFromError(`envFrom: "${name}" has no command`)
      return [name, await resolveOne(name, command, timeoutMs, allowEmpty.has(name))] as const
    }),
  )

  const failure = settled.find(outcome => outcome.status === 'rejected')
  if (failure !== undefined && failure.status === 'rejected') throw failure.reason

  const values: Record<string, string> = {}
  for (const outcome of settled) {
    if (outcome.status !== 'fulfilled') continue
    const [name, value] = outcome.value
    values[name] = value
  }
  return values
}

/**
 * Substitute declared `{{NAME}}` placeholders in a server's arguments.
 *
 * Only names that were actually resolved are replaced. An undeclared
 * placeholder is left verbatim: `{{` appears in legitimate JSON and template
 * arguments, and refusing to start over one would break configurations that
 * have nothing to do with secrets.
 *
 * @param args - The configured argument list.
 * @param resolved - Values from {@link resolveEnvFrom}.
 * @returns A new list, safe to hand to the child.
 */
export function interpolateArgs(
  args: readonly string[],
  resolved: Readonly<Record<string, string>>,
): string[] {
  return args.map(arg =>
    arg.replace(PLACEHOLDER, (whole, name: string) =>
      Object.hasOwn(resolved, name) ? (resolved[name] ?? '') : whole,
    ),
  )
}
