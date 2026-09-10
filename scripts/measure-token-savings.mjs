#!/usr/bin/env node
/**
 * Measure what the gateway actually saves.
 *
 * Publishes a fixture MCP server, asks it for its tool catalog, and renders each
 * tool the way a native registration would have to — name, description, and full
 * input schema. That rendering is the per-request cost `@deepseek-ai/dsh-mcp-client`
 * pays on every request; the gateway pays a single fixed cost instead.
 *
 * Both sides are measured the same way (JSON bytes of the tool definitions, then
 * a four-bytes-per-token estimate), so the ratio is meaningful even though the
 * absolute token count is approximate.
 *
 * Usage:
 *   node scripts/measure-token-savings.mjs                     # local fixture
 *   node scripts/measure-token-savings.mjs --npx <pkg> [args]  # a real server
 *
 * Measured baseline (chrome-devtools-mcp@1.6.0, 29 tools):
 *   native registration  21252 bytes ≈ 5313 tokens
 *   this gateway          1525 bytes ≈  381 tokens   → 92.8% saved
 *
 * Note what the default fixture shows instead: with 7 small tools the native
 * rendering is only 1552 bytes, so the saving is 1.7%. The gateway costs a
 * fixed 1525 bytes, so it wins only when a server's rendered tool definitions
 * exceed that. Small catalogs are close to break-even; large ones are not.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, '..', 'test', 'fixtures', 'mcp-server.mjs')

// A throwaway DSH_HOME, removed on the way out so running the measurement does
// not litter the system temp directory.
const workHome = mkdtempSync(join(tmpdir(), 'dsh-mcp-lazy-measure-'))
process.env['DSH_HOME'] = workHome
process.on('exit', () => rmSync(workHome, { recursive: true, force: true }))

const { createProxyTool } = await import('../lib/proxy-tool.js')
const { McpGatewayRegistry } = await import('../lib/registry.js')

/** Rough token estimate: four bytes per token. */
const tokens = bytes => Math.round(bytes / 4)

/** How a native registration would render one MCP tool. */
function nativeDefinition(serverName, tool) {
  return {
    name: `mcp__${serverName}__${tool.name}`,
    description: tool.description ?? '',
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
  }
}

// ── the gateway's fixed cost ────────────────────────────────────────────────
const registry = new McpGatewayRegistry({ idleTimeout: 10, servers: [] })
const proxy = createProxyTool(registry)
const gatewayBytes = JSON.stringify({
  type: 'function',
  function: { name: proxy.name, description: proxy.description, parameters: proxy.parameters },
}).length

// ── what the same servers cost natively ─────────────────────────────────────
const started = []
async function catalogOf(serverName) {
  const client = new Client({ name: 'measure', version: '1.0.0' }, { capabilities: {} })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fixture] }))
  started.push(client)
  const raw = await client.request({ method: 'tools/list' }, z.unknown())
  return (raw.tools ?? []).map(tool => nativeDefinition(serverName, tool))
}

const npxIndex = process.argv.indexOf('--npx')
const native = []
let serverCount = 1

// The fixture lives under test/, which is not part of the published tarball. A
// copy installed from npm therefore has the script but not its fallback server,
// and the failure mode without this check is an opaque "Connection closed" from
// deep inside the SDK.
if (npxIndex === -1 && !existsSync(fixture)) {
  console.error(
    'measure: no server was given and the development fixture is not present.\n' +
      'It lives at test/fixtures/mcp-server.mjs, which is not shipped in the npm\n' +
      'package. Point the script at a real server instead:\n' +
      '\n' +
      '  node scripts/measure-token-savings.mjs --npx <package> [args...]\n',
  )
  process.exit(2)
}

if (npxIndex !== -1) {
  // Measure a real published server over npx, which is how it would actually be
  // configured, instead of the deliberately tiny local fixture.
  const pkg = process.argv[npxIndex + 1]
  const rest = process.argv.slice(npxIndex + 2)
  if (pkg === undefined) {
    console.error('measure: --npx needs a package name')
    process.exit(2)
  }
  const client = new Client({ name: 'measure', version: '1.0.0' }, { capabilities: {} })
  await client.connect(
    new StdioClientTransport({
      command: 'npx',
      args: ['-y', pkg, ...rest],
      env: { ...process.env },
    }),
  )
  started.push(client)
  const raw = await client.request({ method: 'tools/list' }, z.unknown())
  const serverName = pkg.replace(/^@[^/]+\//, '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 24)
  for (const tool of raw.tools ?? []) native.push(nativeDefinition(serverName, tool))
} else {
  const extraServers = Number.parseInt(process.argv[2] ?? '1', 10)
  serverCount = Number.isFinite(extraServers) && extraServers > 0 ? extraServers : 1
  for (let index = 0; index < serverCount; index += 1) {
    const name = index === 0 ? 'demo' : `demo${index}`
    native.push(...(await catalogOf(name)))
  }
}

const nativeBytes = JSON.stringify(native).length
const saved = nativeBytes - gatewayBytes
const ratio = nativeBytes === 0 ? 0 : (saved / nativeBytes) * 100

console.log(`Tools measured: ${native.length}${npxIndex === -1 ? ` (${native.length / serverCount} per server × ${serverCount})` : ''}`)
console.log('')
console.log(`Native registration (per request):  ${nativeBytes} bytes ≈ ${tokens(nativeBytes)} tokens`)
console.log(`This gateway (per request):         ${gatewayBytes} bytes ≈ ${tokens(gatewayBytes)} tokens`)
console.log(`Saved:                              ${saved} bytes ≈ ${tokens(saved)} tokens (${ratio.toFixed(1)}%)`)
console.log('')
console.log('The gateway figure is constant: adding servers does not change it,')
console.log('because their schemas are read on demand rather than sent every request.')

for (const item of started) {
  if (typeof item.close === 'function') await item.close().catch(() => undefined)
  else item.kill()
}
