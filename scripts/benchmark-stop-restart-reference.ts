import { mkdir, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'

const baseUrl = process.env.PROCESS_INTELLIGENCE_URL ?? 'http://10.8.10.97:8088'
const referenceToUtc = process.env.PHASE3_REFERENCE_TO_UTC ?? '2026-08-13T11:30:00.000Z'
const presses = ['press5', 'press12', 'press14'] as const
const selectors = [{ canonicalId: 'machine.speed.actual', representation: 'samples' }, { canonicalId: 'rewind.tension.actual', representation: 'samples' }, { canonicalId: 'anilox.drive.torque.actual', deckNumber: 1, representation: 'samples' }]
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const bucket = (value: number) => Math.abs(value) < 1 ? 'STOPPED' : Math.abs(value) < 600 ? 'LOW_TRANSITION' : Math.abs(value) <= 1000 ? 'RUNNING' : 'HIGH_SPEED_RUNNING'

async function history(pressKey: string, fromUtc: string, toUtc: string) {
  const started = performance.now()
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/telemetry/presses/${pressKey}/semantic-history`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fromUtc, toUtc, includeSeed: false, signals: selectors }) })
    const body = await response.text()
    if (response.ok) return { value: JSON.parse(body) as { signals: Array<{ canonicalId: string; samples: Array<{ value: unknown }> }> }, bytes: Buffer.byteLength(body), milliseconds: performance.now() - started, retries: attempt }
    if (response.status !== 503 || attempt === 4) throw new Error(`${pressKey} ${fromUtc}: ${response.status}`)
    await wait(2_000 * (attempt + 1))
  }
  throw new Error('unreachable')
}

async function main() {
  const results = []
  const directory = new URL('../review-artifacts/phase3-stop-restart/', import.meta.url)
  await mkdir(directory, { recursive: true })
  for (const pressKey of presses) for (const hours of [24, 72, 168]) {
    const to = Date.parse(referenceToUtc); const from = to - hours * 3_600_000
    const chunks = Array.from({ length: hours / 2 }, (_, index) => ({ fromUtc: new Date(from + index * 2 * 3_600_000).toISOString(), toUtc: new Date(from + (index + 1) * 2 * 3_600_000).toISOString() }))
    const started = performance.now(); const responses = []
    let error: string | null = null
    for (const chunk of chunks) {
      try { responses.push(await history(pressKey, chunk.fromUtc, chunk.toUtc)); await wait(25) }
      catch (caught) { error = caught instanceof Error ? caught.message : String(caught); break }
    }
    const speed = responses.flatMap(({ value }) => value.signals.find(({ canonicalId }) => canonicalId === 'machine.speed.actual')?.samples ?? []).flatMap(({ value }) => typeof value === 'number' && Number.isFinite(value) ? [value] : [])
    const speedBucketObservations = { STOPPED: 0, LOW_TRANSITION: 0, RUNNING: 0, HIGH_SPEED_RUNNING: 0 }
    for (const value of speed) speedBucketObservations[bucket(value)] += 1
    results.push({ pressKey, hours, requests: responses.length, expectedRequests: chunks.length, retries: responses.reduce((sum, item) => sum + item.retries, 0), bytes: responses.reduce((sum, item) => sum + item.bytes, 0), observations: responses.reduce((sum, item) => sum + item.value.signals.reduce((signalSum, signal) => signalSum + signal.samples.length, 0), 0), speedObservations: speed.length, speedBucketObservations, usefulRunningBucketSupport: speedBucketObservations.RUNNING >= 20 || speedBucketObservations.HIGH_SPEED_RUNNING >= 20, wallMs: Math.round(performance.now() - started), aggregateRequestMs: Math.round(responses.reduce((sum, item) => sum + item.milliseconds, 0)), error })
    await writeFile(new URL('reference-benchmark.json', directory), `${JSON.stringify({ generatedAtUtc: new Date().toISOString(), source: baseUrl, referenceToUtc, chunkHours: 2, concurrency: 1, selectors, results }, null, 2)}\n`)
    process.stdout.write(`${pressKey} ${hours}h complete\n`)
  }
  const output = { generatedAtUtc: new Date().toISOString(), source: baseUrl, referenceToUtc, chunkHours: 2, concurrency: 1, selectors, results }
  await writeFile(new URL('reference-benchmark.json', directory), `${JSON.stringify(output, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(results)}\n`)
}

void main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1 })
