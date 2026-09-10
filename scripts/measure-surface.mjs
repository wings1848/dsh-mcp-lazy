#!/usr/bin/env node
/**
 * Measure the per-request cost of the gateway's model-facing surface.
 *
 * The constant this reports is the number this plugin exists to shrink: it is
 * paid on every request of every session, whether or not an MCP tool is ever
 * called. Compare it against the sum of the same servers' tool definitions as
 * registered by `@deepseek-ai/dsh-mcp-client`.
 *
 * Usage:
 *   node scripts/measure-surface.mjs [server-count]
 *
 * With no argument it reports the fixed cost (the proxy tool alone). With a
 * count it also reports the fixed cost plus the number of *live* tool schemas
 * that count would otherwise imply — the gateway never pays those, which is the
 * point of the comparison.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env['DSH_HOME'] = mkdtempSync(join(tmpdir(), 'dsh-mcp-lazy-measure-'))

const { createProxyTool } = await import('../lib/proxy-tool.js')
const { McpGatewayRegistry } = await import('../lib/registry.js')

/** Rough token estimate: four bytes per token. */
function estimateTokens(bytes) {
  return Math.round(bytes / 4)
}

const registry = new McpGatewayRegistry({ idleTimeout: 10, servers: [] })
const tool = createProxyTool(registry)
const wire = JSON.stringify({
  type: 'function',
  function: { name: tool.name, description: tool.description, parameters: tool.parameters },
})

const serverCount = Number.parseInt(process.argv[2] ?? '0', 10)
const parameterCount = Object.keys(tool.parameters.properties ?? {}).length

console.log('Constant model-facing surface (paid on every request):')
console.log(`  tool name        ${tool.name}`)
console.log(`  parameters       ${parameterCount}`)
console.log(`  wire bytes       ${wire.length}`)
console.log(`  approx tokens    ${estimateTokens(wire.length)}`)
if (Number.isFinite(serverCount) && serverCount > 0) {
  console.log('')
  console.log(
    `${serverCount} MCP servers reached through this one tool add 0 further tokens; ` +
      'their schemas stay in the metadata cache and are read only through mcp({ search }).',
  )
}
