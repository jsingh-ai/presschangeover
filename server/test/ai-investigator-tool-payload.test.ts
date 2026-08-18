import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { buildWorstReasonableFleetToolResult, profileWorstReasonableFleetToolResult } from '../scripts/ai-tool-payload-fixture.js'
import { MAX_TOOL_PAYLOAD_BYTES, TOOL_PAYLOAD_ENGINEERING_TARGET_BYTES, profileAiToolPayload } from '../src/ai-investigator/read-only-tools.js'
import { writeValidationCheckpoint } from '../scripts/validation-checkpoint.js'

describe('AI Investigator tool-result containment and validation checkpoints', () => {
  it('profiles the exact guarded serialization boundary with useful offline fleet headroom', () => {
    const result = buildWorstReasonableFleetToolResult()
    const profile = profileWorstReasonableFleetToolResult()
    const { validationDiagnostics: _diagnostics, ...guardedResult } = result
    assert.equal(profile.serializedBytes, Buffer.byteLength(JSON.stringify(guardedResult), 'utf8'))
    assert.equal(profile.limitBytes, MAX_TOOL_PAYLOAD_BYTES)
    assert.equal(profile.diagnosticsExcludedAtBoundary, true)
    assert.equal(profile.withinHardLimit, true)
    assert.equal(profile.withinEngineeringTarget, true)
    assert.ok(profile.serializedBytes <= TOOL_PAYLOAD_ENGINEERING_TARGET_BYTES)
    assert.ok(profile.headroomBytes >= MAX_TOOL_PAYLOAD_BYTES - TOOL_PAYLOAD_ENGINEERING_TARGET_BYTES)
    assert.deepEqual({ observations: profile.observationCount, facts: profile.factCount, traces: profile.traceCount, contextEpisodes: profile.contextEpisodeCount }, { observations: 3, facts: 30, traces: 4, contextEpisodes: 8 })
  })

  it('keeps validation-only diagnostics outside the application guard measurement', () => {
    const result = buildWorstReasonableFleetToolResult()
    const baseline = profileAiToolPayload(result)
    const withLargeDiagnostics = { ...result, validationDiagnostics: { diagnostic: 'x'.repeat(MAX_TOOL_PAYLOAD_BYTES) } }
    assert.equal(profileAiToolPayload(withLargeDiagnostics).serializedBytes, baseline.serializedBytes)
  })

  it('atomically replaces a checkpoint while retaining completed earlier phases', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'process-intelligence-checkpoint-'))
    const path = join(directory, 'validation.json')
    try {
      await writeValidationCheckpoint(path, { status: 'RUNNING', completedPhases: ['startup_safety_checks'] })
      await writeValidationCheckpoint(path, { status: 'NOT_READY', completedPhases: ['startup_safety_checks', 'capability_matrix'], failure: { code: 'bounded_failure' } })
      const checkpoint = JSON.parse(await readFile(path, 'utf8')) as { status: string; completedPhases: string[]; failure: { code: string } }
      assert.equal(checkpoint.status, 'NOT_READY')
      assert.deepEqual(checkpoint.completedPhases, ['startup_safety_checks', 'capability_matrix'])
      assert.equal(checkpoint.failure.code, 'bounded_failure')
      const entries = await import('node:fs/promises').then(({ readdir }) => readdir(directory))
      assert.deepEqual(entries, ['validation.json'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
