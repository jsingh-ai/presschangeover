import { createServer, request as upstreamRequest } from 'node:http'
import { EngineeringClueAnalysisService } from '../server/src/telemetry/engineering-clue-analysis.js'
import type { RadiusPressKey } from '../server/src/radius/models.js'
import type { PressEvidenceCapabilities, PressMotionEvidence, PressSemanticHistoryEvidence, TelemetrySemanticHistoryRequest } from '../server/src/telemetry/telemetry-contracts.js'
import type { TelemetryFoundationService } from '../server/src/telemetry/telemetry-foundation-service.js'

const upstream = new URL(process.argv[2] ?? 'http://10.8.10.97:8088')
const port = Number(process.argv[3] ?? 8099)
const metrics = { clueStarted: 0, clueCompleted: 0, clueAborted: 0, activeClues: 0, maxActiveClues: 0, semanticStarted: 0, activeSemantic: 0, maxActiveSemantic: 0 }

async function upstreamJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path, upstream), init)
  if (!response.ok) throw new Error(`upstream_${response.status}`)
  return response.json() as Promise<T>
}

const telemetry = {
  capabilities: { get: (pressKey: RadiusPressKey, _requestId?: string, signal?: AbortSignal) => upstreamJson<PressEvidenceCapabilities>(`/api/telemetry/presses/${pressKey}/capabilities`, { signal }) },
  semanticHistory: async (pressKey: RadiusPressKey, query: TelemetrySemanticHistoryRequest, _requestId?: string, signal?: AbortSignal) => {
    metrics.semanticStarted += 1; metrics.activeSemantic += 1; metrics.maxActiveSemantic = Math.max(metrics.maxActiveSemantic, metrics.activeSemantic)
    try { return await upstreamJson<PressSemanticHistoryEvidence>(`/api/telemetry/presses/${pressKey}/semantic-history`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query), signal }) }
    finally { metrics.activeSemantic -= 1 }
  },
  motion: (pressKey: RadiusPressKey, fromUtc: string, toUtc: string, _requestId?: string, signal?: AbortSignal) => upstreamJson<PressMotionEvidence>(`/api/telemetry/presses/${pressKey}/motion?${new URLSearchParams({ fromUtc, toUtc })}`, { signal }),
} as unknown as TelemetryFoundationService
const clues = new EngineeringClueAnalysisService(telemetry)

const server = createServer((incoming, response) => {
  const url = new URL(incoming.url ?? '/', 'http://review.local')
  if (url.pathname === '/api/review-engineering-clue-metrics') {
    if (incoming.method === 'POST') for (const key of Object.keys(metrics) as Array<keyof typeof metrics>) metrics[key] = 0
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(metrics))
    return
  }
  const match = url.pathname.match(/^\/api\/telemetry\/presses\/(press(?:3|4|5|6|7|8|9|10|11|12|13|14|15))\/clues$/)
  if (incoming.method === 'POST' && match) {
    const controller = new AbortController()
    let countedAbort = false
    let activeCounted = true
    const finish = () => { if (activeCounted) { activeCounted = false; metrics.activeClues -= 1 } }
    const abort = () => {
      if (response.writableEnded || countedAbort) return
      countedAbort = true; metrics.clueAborted += 1; controller.abort(); finish()
    }
    incoming.on('aborted', abort)
    response.on('close', abort)
    metrics.clueStarted += 1; metrics.activeClues += 1; metrics.maxActiveClues = Math.max(metrics.maxActiveClues, metrics.activeClues)
    const chunks: Buffer[] = []
    let size = 0
    incoming.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= 1_000_000) chunks.push(chunk)
      else incoming.destroy()
    })
    incoming.on('end', () => {
      void (async () => {
        try {
          const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
          const startUtc = String(input.startUtc)
          const endUtc = String(input.endUtc)
          const result = await clues.analyze({
            occurrenceId: String(input.occurrenceId), pressKey: match[1] as RadiusPressKey, displayName: String(input.displayName), startUtc, endUtc,
            durationSeconds: (Date.parse(endUtc) - Date.parse(startUtc)) / 1_000,
            exactIdentities: Array.isArray(input.exactIdentities) ? input.exactIdentities as Array<{ eventType: string; statusCode: string | null; statusDescription: string }> : [],
          }, 'local-review', controller.signal)
          if (controller.signal.aborted || response.destroyed) return
          response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          response.end(JSON.stringify(result))
          metrics.clueCompleted += 1
        } catch {
          if (controller.signal.aborted || response.destroyed) return
          response.writeHead(503, { 'content-type': 'application/json' })
          response.end('{"error":"review_clues_unavailable"}')
        } finally {
          finish()
        }
      })()
    })
    return
  }

  const proxied = upstreamRequest({ protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, method: incoming.method, path: `${url.pathname}${url.search}`, headers: { ...incoming.headers, host: upstream.host } }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
    upstreamResponse.pipe(response)
  })
  proxied.on('error', () => { response.writeHead(502, { 'content-type': 'application/json' }); response.end('{"error":"review_upstream_unavailable"}') })
  incoming.pipe(proxied)
})

server.listen(port, '127.0.0.1', () => console.log(`Engineering clue review API available at http://127.0.0.1:${port}`))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)))
