/**
 * A real MCP server over stdio, used as a test fixture.
 *
 * Plain `.mjs` on purpose: it is spawned as a child process by the
 * `@modelcontextprotocol/sdk` client under test, so it must run without a build
 * step or a TypeScript loader.
 *
 * Environment knobs (all optional):
 *
 * - `FIXTURE_READY_FILE`  — file to touch once the server is listening.
 * - `FIXTURE_START_COUNT` — file incremented on every process start, so a test
 *                           can prove a server was reaped and re-spawned.
 * - `FIXTURE_PID_FILE`    — file receiving this process's pid.
 * - `FIXTURE_INSTRUCTIONS`— server instructions returned during initialization.
 * - `FIXTURE_FAIL`        — exit non-zero immediately, before speaking MCP.
 * - `FIXTURE_FAIL_TOOLS_LIST` — finish the handshake, then fail `tools/list`.
 * - `FIXTURE_EXIT_AFTER_MS` — exit once this many milliseconds have passed.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

const pidFile = process.env.FIXTURE_PID_FILE
if (pidFile) writeFileSync(pidFile, String(process.pid))

const startCountFile = process.env.FIXTURE_START_COUNT
if (startCountFile) appendFileSync(startCountFile, 'start\n')

if (process.env.FIXTURE_FAIL) {
  process.stderr.write('fixture: configured to fail before serving\n')
  process.exit(9)
}

const instructions = process.env.FIXTURE_INSTRUCTIONS
const server = new McpServer(
  { name: 'dsh-mcp-lazy-fixture', version: '1.0.0' },
  instructions ? { instructions } : {},
)

server.registerTool(
  'echo',
  {
    description: 'Echo back the provided text.',
    inputSchema: { text: z.string().describe('Text to echo') },
  },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
)

server.registerTool(
  'get_pixels',
  {
    description: 'Return a tiny PNG image block, to exercise non-text projection.',
  },
  async () => ({
    content: [
      { type: 'text', text: 'here is the image' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ],
  }),
)

server.registerTool(
  'self_report',
  { description: 'Report which process is serving this call.' },
  async () => ({
    content: [{ type: 'text', text: `pid=${process.pid} starts=${countStarts()}` }],
  }),
)

server.registerTool(
  'slow',
  {
    description: 'Wait before answering, to exercise in-flight protection.',
    inputSchema: { ms: z.number().describe('How long to wait') },
  },
  async ({ ms }) => {
    await new Promise(resolve => setTimeout(resolve, ms))
    return { content: [{ type: 'text', text: `waited ${ms}ms` }] }
  },
)

server.registerTool(
  'add_tool',
  {
    description: 'Register an extra tool on this running server.',
    inputSchema: { name: z.string().describe('Name of the tool to add') },
  },
  async ({ name }) => {
    server.registerTool(name, { description: `Dynamically added tool ${name}.` }, async () => ({
      content: [{ type: 'text', text: `dynamic ${name}` }],
    }))
    // The high-level server notifies connected clients on its own.
    return { content: [{ type: 'text', text: `added ${name}` }] }
  },
)

server.registerTool(
  'dump_env',
  {
    description: 'Report whether specific environment variables reached this process.',
    inputSchema: { names: z.array(z.string()).describe('Variable names to check') },
  },
  async ({ names }) => ({
    content: [
      {
        type: 'text',
        text: names.map(name => `${name}=${process.env[name] ?? '<unset>'}`).join('\n'),
      },
    ],
  }),
)

server.registerTool(
  'always_fails',
  { description: 'Always return an MCP error result.' },
  async () => ({ content: [{ type: 'text', text: 'this tool always fails' }], isError: true }),
)

/** How many times this fixture has been started, from its counter file. */
function countStarts() {
  if (!startCountFile) return 1
  try {
    return readFileSync(startCountFile, 'utf8')
      .split('\n')
      .filter(line => line !== '').length
  } catch {
    return 1
  }
}

const exitAfter = Number(process.env.FIXTURE_EXIT_AFTER_MS ?? '0')
if (Number.isFinite(exitAfter) && exitAfter > 0) {
  setTimeout(() => process.exit(0), exitAfter).unref()
}

// Fail `tools/list` while `initialize` keeps succeeding. `FIXTURE_FAIL` exits
// before the handshake, which the SDK cleans up on its own; this knob covers the
// window after a server is up but its catalog cannot be read, which is where a
// half-open connection has to be torn down by hand.
//
// This has to run after every `registerTool` call, because the first one installs
// the SDK's own `tools/list` handler.
if (process.env.FIXTURE_FAIL_TOOLS_LIST) {
  server.server.setRequestHandler(ListToolsRequestSchema, () => {
    throw new Error('fixture: tools/list is configured to fail')
  })
}

const readyFile = process.env.FIXTURE_READY_FILE
await server.connect(new StdioServerTransport())
if (readyFile) writeFileSync(readyFile, 'ready')
