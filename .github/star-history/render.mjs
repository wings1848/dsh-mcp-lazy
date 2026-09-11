#!/usr/bin/env node
/**
 * Render a star-history chart from a snapshot log.
 *
 * Why this exists instead of a star-history service: GitHub stopped serving the
 * stargazers *list* to anything but a repository admin's own credential, so
 * every timeline chart needs either a personal access token or a third-party
 * action holding one. The stargazers *count* is still readable by the built-in
 * `GITHUB_TOKEN`, so this takes the other route -- record the count once a day
 * and draw the timeline yourself.
 *
 * For a repository that already has history that is a real trade: a token can
 * backfill, this cannot. For a new repository it costs nothing, because there is
 * no history to backfill. The chart simply starts on the day the workflow first
 * runs.
 *
 * Usage:
 *   node render.mjs <history.json> <out-dir>                 # draw only
 *   node render.mjs <history.json> <out-dir> --record <n>    # add today, then draw
 *
 * With `--record` the normalised history is written back, so the file on the
 * publishing branch stays sorted and de-duplicated even if someone edits it by
 * hand. Without it the file is left exactly as found, which is what a local
 * preview wants.
 *
 * `history.json` is an array of `{ "date": "YYYY-MM-DD", "stars": <number> }`,
 * oldest first. Two SVGs are written, one per colour scheme; the README picks
 * between them with `<picture>` and `prefers-color-scheme`, which is the only
 * way to get a chart that is legible in both of GitHub's themes.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const WIDTH = 860
const HEIGHT = 280
const PAD = { top: 44, right: 28, bottom: 40, left: 52 }

/** Colour schemes. Same geometry, different ink. */
const THEMES = {
  light: {
    bg: '#ffffff',
    border: '#d0d7de',
    grid: '#eaeef2',
    axis: '#8c959f',
    line: '#1a7f37',
    area: '#1a7f37',
    text: '#1f2328',
    muted: '#656d76',
    dot: '#1a7f37',
    dotRing: '#ffffff',
  },
  dark: {
    bg: '#0d1117',
    border: '#30363d',
    grid: '#21262d',
    axis: '#6e7681',
    line: '#3fb950',
    area: '#3fb950',
    text: '#e6edf3',
    muted: '#8b949e',
    dot: '#3fb950',
    dotRing: '#0d1117',
  },
}

const FONT = 'ui-sans-serif,-apple-system,Segoe UI,Helvetica,Arial,sans-serif'

/**
 * Escape the five characters that would otherwise end the text node or start a
 * tag. Dates and integers cannot contain them, but a chart that breaks on
 * unexpected input is worse than one extra line.
 *
 * @param value - Raw text.
 * @returns Text safe to interpolate into SVG markup.
 */
function escape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Drop malformed rows and sort oldest first.
 *
 * The file is written by a workflow, but it is also committed to a branch, which
 * means a human can edit it and a bad row should not take the chart down.
 *
 * @param raw - Parsed JSON, expected to be an array.
 * @returns Clean, ordered samples.
 */
function normalise(raw) {
  if (!Array.isArray(raw)) return []
  const clean = raw.filter(
    row =>
      row !== null
      && typeof row === 'object'
      && typeof row.date === 'string'
      && Number.isFinite(row.stars)
      && row.stars >= 0,
  )
  clean.sort((a, b) => a.date.localeCompare(b.date))
  // One sample per day: the last write for a date wins.
  const byDate = new Map()
  for (const row of clean) byDate.set(row.date, row)
  return [...byDate.values()]
}

/**
 * Choose an axis maximum at or above `value`.
 *
 * Every candidate is a multiple of four, because the chart draws four
 * divisions. Without that the gridlines land on 12.5 and 37.5, and a star count
 * is never fractional -- a chart that says "37.5 stars" looks like it does not
 * know what it is counting.
 *
 * @param value - The largest count in the series.
 * @returns A maximum that produces readable, integral gridlines.
 */
function niceMax(value) {
  for (const candidate of NICE_MAXIMA) {
    if (candidate >= value) return candidate
  }
  return Math.ceil(value / 400) * 400
}

/** Multiples of four, ascending. Past 100 the steps get coarse on purpose. */
const NICE_MAXIMA = [
  4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 100, 120, 160, 200, 240, 320, 400,
]

/**
 * Build one theme's chart.
 *
 * @param samples - Normalised history.
 * @param theme - Palette to draw with.
 * @returns SVG source.
 */
function render(samples, theme) {
  const plotW = WIDTH - PAD.left - PAD.right
  const plotH = HEIGHT - PAD.top - PAD.bottom
  const current = samples.length > 0 ? samples[samples.length - 1].stars : 0
  const peak = samples.reduce((max, row) => Math.max(max, row.stars), 0)
  const top = niceMax(peak)

  // A single sample has no span to divide by; draw it in the middle.
  const span = Math.max(1, samples.length - 1)
  const xAt = index => PAD.left + (samples.length === 1 ? plotW / 2 : (index / span) * plotW)
  const yAt = stars => PAD.top + plotH - (stars / top) * plotH

  const points = samples.map((row, index) => [xAt(index), yAt(row.stars)])
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = points.length > 0
    ? `M ${points[0][0].toFixed(1)},${(PAD.top + plotH).toFixed(1)} `
      + `L ${line.replace(/ /g, ' L ')} `
      + `L ${points[points.length - 1][0].toFixed(1)},${(PAD.top + plotH).toFixed(1)} Z`
    : ''

  // Four gridlines, always including the baseline.
  const gridlines = [0, 0.25, 0.5, 0.75, 1].map(fraction => {
    const y = PAD.top + plotH - fraction * plotH
    const value = top * fraction
    const label = Number.isInteger(value) ? String(value) : value.toFixed(1)
    return `  <line x1="${PAD.left}" y1="${y.toFixed(1)}" x2="${WIDTH - PAD.right}" y2="${y.toFixed(1)}" stroke="${theme.grid}"/>\n`
      + `  <text x="${PAD.left - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-family="${FONT}" font-size="11" fill="${theme.muted}">${escape(label)}</text>`
  }).join('\n')

  const firstDate = samples.length > 0 ? samples[0].date : ''
  const lastDate = samples.length > 0 ? samples[samples.length - 1].date : ''
  const xLabels = samples.length > 0
    ? `  <text x="${PAD.left}" y="${HEIGHT - 12}" font-family="${FONT}" font-size="11" fill="${theme.muted}">${escape(firstDate)}</text>\n`
      + (samples.length > 1
        ? `  <text x="${WIDTH - PAD.right}" y="${HEIGHT - 12}" text-anchor="end" font-family="${FONT}" font-size="11" fill="${theme.muted}">${escape(lastDate)}</text>`
        : '')
    : `  <text x="${WIDTH / 2}" y="${PAD.top + plotH / 2}" text-anchor="middle" font-family="${FONT}" font-size="13" fill="${theme.muted}">no samples yet</text>`

  const last = points.length > 0 ? points[points.length - 1] : undefined
  const marker = last !== undefined
    ? `  <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="5" fill="${theme.dotRing}"/>\n`
      + `  <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.5" fill="${theme.dot}"/>`
    : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-label="Star history: ${current} star${current === 1 ? '' : 's'}">
  <title>Star history</title>
  <rect width="${WIDTH}" height="${HEIGHT}" rx="10" fill="${theme.bg}" stroke="${theme.border}"/>
  <text x="${PAD.left}" y="26" font-family="${FONT}" font-size="14" font-weight="600" fill="${theme.text}">Stars</text>
  <text x="${WIDTH - PAD.right}" y="26" text-anchor="end" font-family="${FONT}" font-size="20" font-weight="600" fill="${theme.line}">${escape(String(current))}</text>
${gridlines}
${area !== '' ? `  <path d="${area}" fill="${theme.area}" fill-opacity="0.14"/>` : ''}
${points.length > 1 ? `  <polyline points="${line}" fill="none" stroke="${theme.line}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
${marker}
${xLabels}
</svg>
`
}

const [, , historyPath, outDir, ...rest] = process.argv
if (historyPath === undefined || outDir === undefined) {
  console.error('usage: render.mjs <history.json> <out-dir> [--record <count>]')
  process.exit(2)
}

const recordIndex = rest.indexOf('--record')
const record = recordIndex === -1 ? undefined : Number.parseInt(rest[recordIndex + 1] ?? '', 10)
if (recordIndex !== -1 && !Number.isFinite(record)) {
  console.error('render: --record needs a number')
  process.exit(2)
}

let parsed = []
try {
  parsed = JSON.parse(readFileSync(historyPath, 'utf8'))
} catch (error) {
  console.error(`render: could not read ${historyPath}: ${error.message}`)
  console.error('render: writing an empty chart instead of failing the run')
}

const samples = normalise(parsed)
if (record !== undefined) {
  // Same-day re-runs replace the earlier sample rather than adding a second
  // point, so a manual dispatch after the cron does not pad the series.
  samples.push({ date: new Date().toISOString().slice(0, 10), stars: record })
}
const finalSamples = normalise(samples)

if (record !== undefined) {
  writeFileSync(historyPath, `${JSON.stringify(finalSamples, null, 2)}\n`)
}

for (const [name, theme] of Object.entries(THEMES)) {
  writeFileSync(join(outDir, `star-history-${name}.svg`), render(finalSamples, theme))
}
console.log(
  `render: ${finalSamples.length} sample(s), latest ${finalSamples.at(-1)?.stars ?? 0} star(s)`,
)
