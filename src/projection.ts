/**
 * The one renderer for a projected MCP tool result.
 *
 * Two callers need this text and neither may own it: the proxy tool, which
 * fronts every MCP server, and a promoted native tool, which the model calls
 * directly. Each used to carry a private copy of the same logic, and the copies
 * drifted — the native one dropped `structuredContent` entirely, so a tool that
 * answers with structured content and no text block read as "returned no
 * content" once it was promoted and as JSON while it stayed behind the proxy.
 * Which answer the model got depended on a configuration flag rather than on the
 * server.
 *
 * One implementation, one answer. A caller that needs different text has to
 * change it here, where the other path sees the change too.
 *
 * @module dsh-mcp-lazy/projection
 */

import type { ProjectedBlock, ToolCallResult } from './types.js'

/**
 * Render one projected block as a line of text.
 *
 * Anything this gateway cannot forward verbatim — image, audio — is reported as
 * metadata instead of being dropped: saying what arrived and how large it was is
 * what lets the model ask for another route, while a silent removal reads as an
 * empty answer.
 *
 * @param block - The projected block.
 * @returns One line of text.
 */
export function renderBlock(block: ProjectedBlock): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'image':
      return (
        `[image: ${block.mimeType}, ${block.bytes} bytes — this gateway returns text only, ` +
        'so the pixels are not forwarded]'
      )
    case 'audio':
      return `[audio: ${block.mimeType}, ${block.bytes} bytes — not forwarded]`
    case 'resource_link':
      return `[resource: ${block.name === undefined ? block.uri : `${block.name} <${block.uri}>`}]`
    case 'unknown':
      return `[${block.detail}]`
  }
}

/**
 * Render one MCP tool result.
 *
 * A server-reported error is surfaced as an error, not a success: the call
 * happened, and pretending otherwise would teach the model the wrong lesson.
 * The proxy has always rendered that case from the text blocks alone, with
 * `(no detail)` when there are none; that is kept here rather than quietly
 * changed, because this function's job is to end the divergence between the two
 * paths, not to pick a third answer.
 *
 * @param toolName - The tool that ran, for the header.
 * @param result - The live result.
 * @returns Text for the model.
 */
export function renderToolResult(toolName: string, result: unknown): string {
  if (typeof result === 'string') return result
  if (typeof result !== 'object' || result === null) return JSON.stringify(result, null, 2)

  const projected = result as Partial<ToolCallResult>
  const blocks = Array.isArray(projected.blocks) ? projected.blocks : undefined
  if (blocks === undefined) {
    // Not one of ours — hand back the JSON rather than inventing a shape.
    return JSON.stringify(result, null, 2)
  }

  const body = blocks.map(renderBlock).filter(text => text !== '').join('\n')
  const structured =
    projected.structuredContent === undefined
      ? ''
      : `\n\n${JSON.stringify(projected.structuredContent, null, 2)}`

  if (projected.isError === true) {
    return `${toolName} reported an error:\n${body === '' ? '(no detail)' : body}`
  }
  if (body === '' && structured === '') return `${toolName} returned no content.`
  return `${body}${structured}`
}
