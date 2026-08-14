import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const panel = readFileSync(new URL('../src/components/StopRestartAnalysisPanel.tsx', import.meta.url), 'utf8')
const clues = readFileSync(new URL('../src/components/TelemetryCluesPanel.tsx', import.meta.url), 'utf8')
const inspector = readFileSync(new URL('../src/components/EngineeringTelemetryInspector.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api/process-intelligence-api.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

describe('Phase 3 stop/restart client integration', () => {
  it('makes physical analysis primary while preserving generic clues as secondary evidence', () => {
    assert.ok(clues.indexOf('<StopRestartAnalysisPanel') < clues.indexOf('Other Telemetry Changes'))
    assert.match(clues, /<details className="other-telemetry-changes"/)
    assert.match(clues, /open={stopAnalysis\?\.physicalStopMatch\.status !== 'MATCHED'}/)
    assert.match(panel, /Physical speed anchors this chronology/)
    assert.match(panel, /Radius remains the synchronized operator-recorded explanation/)
  })

  it('renders a synchronized physical timeline and compact contextual chronology', () => {
    assert.match(panel, /SynchronizedTimeline/)
    assert.match(panel, /Stable physical running/)
    assert.match(panel, /Observed lead-up \/ deceleration/)
    assert.match(panel, /Physical stop/)
    assert.match(panel, /Sustained physical running resumed/)
    assert.match(panel, /Stop \/ Restart Context/)
    assert.match(panel, /Raw state and Radius evidence remain context/)
  })

  it('shows conservative comparable-speed flags with trace and pin actions', () => {
    assert.match(panel, /Potential Pre-Stop Flags/)
    assert.match(panel, /Comparable-speed reference/)
    assert.match(panel, /View Trace/)
    assert.match(panel, />Pin</)
    assert.match(panel, /data\.noFlagMessage/)
    assert.match(clues, /onView={openInspectorTarget}/)
    assert.match(clues, /onPin={pinState\.pin}/)
    assert.match(panel, /data\.preStopFlags\.length \? <section/)
    assert.match(panel, /The Engineering Inspector remains available for direct trace review/)
  })

  it('distinguishes raw restart excursions from failed-running attempts', () => {
    assert.match(panel, /Brief low-speed excursion/)
    assert.match(panel, /Failed running attempt/)
    assert.match(panel, /Reached ≥600, then returned to STOPPED/)
    assert.match(panel, /Sustained physical running resumed/)
    assert.doesNotMatch(panel, /<h3>Restart attempts<\/h3>/)
  })

  it('cancels stale stop analysis and keeps existing evidence usable on failure', () => {
    assert.match(panel, /new AbortController\(\)/)
    assert.match(panel, /controller\.abort\(\)/)
    assert.match(panel, /value\.occurrence\.occurrenceId === occurrenceId/)
    assert.match(panel, /Telemetry Clues and the Engineering Inspector remain usable/)
    assert.match(api, /stop-restart-analysis/)
    assert.match(api, /radius-timing-analysis/)
    assert.match(api, /fleet-speed-context/)
  })

  it('loads Radius timing as secondary work and fleet speed only on request', () => {
    assert.match(panel, /timingPeers\.length < 2/)
    assert.match(panel, /Matched physical stops/)
    assert.match(panel, /Radius before \/ near \/ after/)
    assert.match(panel, /Median requires 3 matched occurrences/)
    assert.match(panel, /Load fleet speed context/)
    assert.match(panel, /fleetRequested/)
    assert.match(panel, /Direct raw fleet comparison|rawEngineeringComparison\.message/)
  })

  it('adds exact physical markers to existing inspector traces without duplicating Radius tracks', () => {
    for (const marker of ['Observed deceleration', 'Physical stop', 'Sustained physical running confirmed']) assert.match(inspector, new RegExp(marker))
    assert.doesNotMatch(inspector, /Radius track/i)
    assert.match(inspector, /stopAnalysis\?\.physicalStopMatch/)
  })

  it('has responsive panel rules and uses neutral investigative language', () => {
    assert.match(styles, /\.stop-restart-analysis/)
    assert.match(styles, /@media \(max-width: 760px\)/)
    assert.doesNotMatch(panel, /root cause|operator (?:late|delay|error)|machine health|confirmed production|normal operating limit|unsafe|bad deck|failure caused/i)
    assert.doesNotMatch(panel, /S\s*\/\s*400[\s\S]{0,60}Safety/i)
  })
})
