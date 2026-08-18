import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { aiInvestigatorDiscoveryTextFormat } from '../src/ai-investigator/contracts.js'
import { buildDiscoveryPreflight, DISCOVERY_INSTRUCTIONS, DISCOVERY_OUTPUT_TOKENS, DISCOVERY_PROMPT_CACHE_KEY } from '../src/ai-investigator/discovery.js'
import { profileAiResponsesRequest } from '../src/ai-investigator/offline-profiler.js'
import { buildAiResponsesRequestPayload } from '../src/ai-investigator/orchestrator.js'
import { DiscoveryFixtureExecutor, fixtureCurrent } from '../test/fixtures/ai-investigator-discovery-fixture.js'
import { profileWorstReasonableFleetToolResult } from './ai-tool-payload-fixture.js'
import { writeValidationCheckpoint } from './validation-checkpoint.js'

const projectRoot = resolve(import.meta.dirname, '..', '..')
const artifactPath = resolve(projectRoot, 'staging', 'ai-investigator-local-regression.json')
const npmCli = process.env.npm_execpath ?? resolve(process.execPath, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js')
const npmCommand = (args: string[]): [string, string[]] => [process.execPath, [npmCli, ...args]]

interface CommandResult { command: string; exitCode: number; runtimeMs: number; stdout: string; stderr: string }

async function run(file: string, args: string[]): Promise<CommandResult> {
  const began = Date.now()
  return await new Promise((resolveResult, reject) => {
    const child = spawn(file, args, { cwd: projectRoot, env: process.env, windowsHide: true, shell: false })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { const text = chunk.toString(); stdout += text; process.stdout.write(text) })
    child.stderr.on('data', (chunk: Buffer) => { const text = chunk.toString(); stderr += text; process.stderr.write(text) })
    child.once('error', reject)
    child.once('close', (code) => resolveResult({ command: [file, ...args].join(' '), exitCode: code ?? 1, runtimeMs: Date.now() - began, stdout, stderr }))
  })
}

function testCounts(output: string) {
  const value = (label: string) => Number(output.match(new RegExp(`(?:#|ℹ)\\s*${label}\\s+(\\d+)`, 'i'))?.[1] ?? 0)
  return { tests: value('tests'), passed: value('pass'), failed: value('fail') }
}

async function offlineModelProfile(pressKey: 'press14' | null) {
  const preflight = await buildDiscoveryPreflight(new DiscoveryFixtureExecutor(true), { scope: { pressKey }, range: fixtureCurrent, analysis: 'discover_unusual_behavior' }, new AbortController().signal)
  const format = aiInvestigatorDiscoveryTextFormat(preflight.candidates.length)
  const payload = buildAiResponsesRequestPayload('offline-validation-model', [{ role: 'user', content: JSON.stringify(preflight.modelInput) }], DISCOVERY_INSTRUCTIONS, [], 'none', { structuredOutputSchema: format.schema as Record<string, unknown>, structuredOutputFormat: format, structuredOutputName: 'process_intelligence_discovery', maxOutputTokens: DISCOVERY_OUTPUT_TOKENS, promptCacheKey: DISCOVERY_PROMPT_CACHE_KEY })
  return { ...profileAiResponsesRequest(payload), compactModelInputBytes: Buffer.byteLength(JSON.stringify(preflight.modelInput), 'utf8'), candidateCount: preflight.candidates.length, authoritativeTraceCount: preflight.candidates.reduce((sum, candidate) => sum + (candidate.traces?.length ?? 0), 0), modelTraceCount: ((preflight.modelInput.candidates as Array<{ traces?: unknown[] }> | undefined) ?? []).reduce((sum, candidate) => sum + (candidate.traces?.length ?? 0), 0), sectionTokenAttribution: preflight.instrumentation.sectionTokenContributions }
}

const offlineModelProfiles = { selectedPress: await offlineModelProfile('press14'), fleet: await offlineModelProfile(null) }

const results = {
  serverTests: await run(...npmCommand(['run', 'test', '--workspace', 'server'])),
  clientTests: await run(...npmCommand(['run', 'test', '--workspace', 'client'])),
  typecheck: await run(...npmCommand(['run', 'typecheck'])),
  build: await run(...npmCommand(['run', 'build'])),
  gitDiffCheck: await run('git', ['diff', '--check']),
}
const commands = Object.fromEntries(Object.entries(results).map(([name, result]) => [name, { command: result.command, exitCode: result.exitCode, runtimeMs: result.runtimeMs }]))
const artifact = {
  validation: 'ai-investigator-local-release-regression',
  generatedAtUtc: new Date().toISOString(),
  status: Object.values(results).every((result) => result.exitCode === 0) && offlineModelProfiles.selectedPress.estimatedInputTokens <= 2_500 && offlineModelProfiles.fleet.estimatedInputTokens <= 6_000 ? 'PASS' : 'FAIL',
  actualTestResults: {
    server: testCounts(`${results.serverTests.stdout}\n${results.serverTests.stderr}`),
    client: testCounts(`${results.clientTests.stdout}\n${results.clientTests.stderr}`),
  },
  commands,
  offlineToolPayload: profileWorstReasonableFleetToolResult(),
  offlineModelProfiles,
  openAiApiRequests: 0,
  productionQueries: 0,
}
await writeValidationCheckpoint(artifactPath, artifact)
console.log(`Local regression artifact: ${artifactPath}`)
console.log(`Offline fleet tool result: ${artifact.offlineToolPayload.serializedBytes} bytes; ${artifact.offlineToolPayload.headroomBytes} bytes hard-limit headroom`)
if (artifact.status !== 'PASS') process.exitCode = 1
