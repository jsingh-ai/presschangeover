import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DateTime } from 'luxon'
import { createPressDowntimePresetRange, PRESS_DOWNTIME_MAX_RANGE_MS, PRESS_DOWNTIME_PRESS_KEYS, pressDowntimeSegments, validPressDowntimeRange } from '../src/components/PressDowntimePage'
import type { PressDowntimeJobGroup } from '../src/types/press-downtime'

test('Press Downtime owns all twelve press cards and exact 24/72-hour ranges', () => {
  assert.deepEqual(PRESS_DOWNTIME_PRESS_KEYS, ['press3', 'press5', 'press6', 'press7', 'press8', 'press9', 'press10', 'press11', 'press12', 'press13', 'press14', 'press15'])
  const now = DateTime.fromISO('2026-08-28T12:00:00Z')
  assert.equal(Date.parse(createPressDowntimePresetRange('last24', now).toUtc) - Date.parse(createPressDowntimePresetRange('last24', now).fromUtc), 24 * 60 * 60_000)
  assert.equal(Date.parse(createPressDowntimePresetRange('last72', now).toUtc) - Date.parse(createPressDowntimePresetRange('last72', now).fromUtc), PRESS_DOWNTIME_MAX_RANGE_MS)
  assert.equal(validPressDowntimeRange('2026-08-25T12:00:00Z', '2026-08-28T12:00:00Z'), true)
  assert.equal(validPressDowntimeRange('2026-08-25T11:59:59Z', '2026-08-28T12:00:00Z'), false)
})

test('repeated jobs remain grouped while exact category segments remain expandable', () => {
  const group = { occurrences: [
    { segments: [{ segmentId: 'one', category: 'CHANGEOVER' }, { segmentId: 'two', category: 'GOOD_RUN' }] },
    { segments: [{ segmentId: 'three', category: 'CHANGEOVER' }] },
  ] } as unknown as PressDowntimeJobGroup
  assert.deepEqual(pressDowntimeSegments(group, 'CHANGEOVER').map(({ segmentId }) => segmentId), ['one', 'three'])
  const source = readFileSync(new URL('../src/components/PressDowntimePage.tsx', import.meta.url), 'utf8')
  assert.match(source, /Job instances/)
  assert.match(source, /temporary Order or Recipe gap appears as Missing Data inside the same instance/)
  assert.match(source, /<SegmentList group=\{group\} category=\{category\}/)
  assert.match(source, /new Set\(\['press3'\]\)/)
  assert.match(source, /Open to load/)
  assert.match(source, /Loading this press only/)
  assert.match(source, /PressComparisonTimeline report=\{report\}/)
  assert.match(source, /Review roll sizes and classifications/)
  assert.match(source, /<PressDowntimeSpeedTrend report=\{report\}/)
  assert.match(source, /identityRow\('order'\)/)
  assert.match(source, /identityRow\('recipe'\)/)
  assert.doesNotMatch(source, /<strong>Radius codes<\/strong>/)
  assert.match(source, /Radius time split/)
  assert.match(source, /ProcessIntelligence time split/)
  assert.match(source, /Roll outcome/)
  assert.match(source, /Production versus loss/)
  for (const label of ['Changeover', 'Good Run', 'Downtime', 'Missing Data']) assert.match(source, new RegExp(label))
})

test('Press Downtime is a first-class route with progressive read-only API loading and responsive cards', () => {
  const navigation = readFileSync(new URL('../src/navigation.ts', import.meta.url), 'utf8')
  const shell = readFileSync(new URL('../src/components/ApplicationShell.tsx', import.meta.url), 'utf8')
  const api = readFileSync(new URL('../src/api/process-intelligence-api.ts', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
  assert.match(navigation, /press-downtime/)
  assert.match(shell, /label: 'Press Downtime'/)
  assert.match(api, /\/api\/press-downtime\/presses\/\$\{encodeURIComponent\(pressKey\)\}/)
  assert.match(styles, /\.pd-press-grid \{ display: grid; grid-template-columns: 1fr/)
  assert.match(styles, /\.pd-press-header \{ position: sticky/)
  assert.match(styles, /\.pd-gantt-track/)
  assert.match(styles, /\.ours-good-run/)
  assert.match(styles, /\.pd-speed-track/)
  assert.match(styles, /\.pd-identity-track/)
  assert.match(styles, /\.pd-comparison-summary/)
  assert.match(styles, /\.pd-job-decision-grid/)
  assert.match(styles, /\.pd-job-instances/)
})
