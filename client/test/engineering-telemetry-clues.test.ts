import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const panelSource = readFileSync(new URL('../src/components/TelemetryCluesPanel.tsx', import.meta.url), 'utf8')
const operationalSource = readFileSync(new URL('../src/components/OperationalActivityExplorer.tsx', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('../src/api/process-intelligence-api.ts', import.meta.url), 'utf8')
const serverClueSource = readFileSync(new URL('../../server/src/telemetry/engineering-clue-analysis.ts', import.meta.url), 'utf8')

describe('Engineering Telemetry Clues client integration', () => {
  it('mounts clues in the focused-occurrence workflow after the full-range signature', () => {
    const signature = operationalSource.indexOf('<FullRangePhysicalSignature')
    const clues = operationalSource.indexOf('<TelemetryCluesPanel')
    const occurrences = operationalSource.indexOf('{exactOccurrences}', clues)
    assert.ok(signature >= 0 && clues > signature && occurrences > clues)
    assert.match(operationalSource, /previous=\{focusedOccurrenceIndex > 0/)
    assert.match(operationalSource, /next=\{focusedOccurrenceIndex >= 0/)
  })

  it('cancels stale clue and trace requests and clears the previous occurrence response', () => {
    assert.ok((panelSource.match(/new AbortController\(\)/g) ?? []).length >= 2)
    assert.ok((panelSource.match(/controller\.abort\(\)/g) ?? []).length >= 2)
    assert.match(panelSource, /value\.occurrence\.occurrenceId === identity/)
    assert.match(panelSource, /setData\(undefined\); setLoading\(true\)/)
  })

  it('uses the existing generic semantic-history route for a single selected View Trace signal', () => {
    assert.match(apiSource, /getPressSemanticHistory/)
    assert.match(apiSource, /semantic-history/)
    assert.match(panelSource, /signals: \[\{ canonicalId: clue\.canonicalId/)
    assert.match(panelSource, /SynchronizedTimeline/)
    assert.match(panelSource, /Radius entry/)
    assert.match(panelSource, /Occurrence end/)
    assert.match(panelSource, /Evidence window starts/)
    assert.match(panelSource, /Evidence window ends/)
    assert.match(panelSource, /clue\.canonicalId === 'physical\.motion_state'/)
    assert.match(panelSource, /getPressMotion\(occurrence\.pressKey, window\.fromUtc, window\.toUtc/)
    assert.match(panelSource, /clue\.signalType === 'continuous' \? 'samples' : 'changes'/)
    assert.match(panelSource, /selected-step-signal/)
    assert.match(panelSource, /raw transitions/)
  })

  it('keeps the Operational page usable when clue telemetry is unavailable', () => {
    assert.match(panelSource, /Telemetry clues are temporarily unavailable/)
    assert.match(panelSource, /activity summaries, full-range signature, and exact evidence remain usable/)
  })

  it('uses neutral evidence language and introduces no S\/400\/Sort Safety assumption', () => {
    assert.doesNotMatch(panelSource, /root cause|operator error|quality problem|causal relationship|machine health|confirmed production|abnormal condition|S\s*\/\s*400[\s\S]{0,60}Safety/i)
    assert.doesNotMatch(operationalSource, /S\s*\/\s*400[\s\S]{0,60}Safety/i)
    assert.match(panelSource, /closer inspection/)
    assert.match(panelSource, /First observed evidence of this distribution shift/)
    assert.match(panelSource, /Raw transition observed/)
    assert.doesNotMatch(serverClueSource, /root cause|operator error|machine health|confirmed production|abnormal condition/i)
  })

  it('uses roving tabindex and arrow-key matrix navigation while preserving accessible detail', () => {
    assert.match(panelSource, /tabIndex=\{key === activeKey \? 0 : -1\}/)
    assert.match(panelSource, /ArrowUp/)
    assert.match(panelSource, /ArrowDown/)
    assert.match(panelSource, /ArrowLeft/)
    assert.match(panelSource, /ArrowRight/)
    assert.match(panelSource, /aria-label=/)
    assert.match(panelSource, /Use arrow keys to inspect every scope and category/)
    for (const state of ['multiple_clues', 'one_clue', 'observed_no_shift', 'insufficient', 'temporarily_unavailable', 'unknown', 'unsupported']) assert.match(panelSource, new RegExp(state))
  })

  it('shows explicit observation-confidence states without calling sparse data stable', () => {
    for (const state of ['OBSERVED', 'LIMITED_OBSERVATION', 'NO_USABLE_OBSERVATION', 'TEMPORARILY_UNAVAILABLE']) assert.match(panelSource, new RegExp(state))
    assert.match(panelSource, /Unsupported on this press/)
    assert.doesNotMatch(panelSource, /stable/i)
  })
})
