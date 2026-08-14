import { readFile, writeFile } from 'node:fs/promises'

const base = process.env.PHASE3_CANDIDATE_URL ?? 'http://127.0.0.1:8091'
const artifact = new URL('../review-artifacts/phase3-stop-restart/phase31-real-data-validation.json', import.meta.url)
const output = new URL('../review-artifacts/phase3-stop-restart/phase31-flag-trace-review.json', import.meta.url)

async function main() {
  const validation = JSON.parse(await readFile(artifact, 'utf8'))
  const reviewed = []
  for (const occurrence of validation.reviewed) for (const flag of occurrence.flags ?? []) {
    const stable = occurrence.stableRunningAudit
    const selectors = [{ canonicalId: flag.canonicalId, ...(flag.deckNumber === null ? {} : { deckNumber: flag.deckNumber }), representation: 'samples' }]
    if (flag.deckNumber !== null) selectors.push({ canonicalId: 'deck.active', deckNumber: flag.deckNumber, representation: 'changes' })
    const response = await fetch(`${base}/api/telemetry/presses/${occurrence.pressKey}/semantic-history`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fromUtc: new Date(Date.parse(occurrence.startUtc) - 30 * 60_000).toISOString(), toUtc: new Date(Date.parse(occurrence.startUtc) + 10 * 60_000).toISOString(), includeSeed: true, signals: selectors }) })
    if (!response.ok) throw new Error(`${occurrence.pressKey}: ${response.status}`)
    const history = await response.json() as { signals: Array<{ canonicalId: string; seed: null | { observedAtUtc: string; value: unknown }; samples: Array<{ observedAtUtc: string; value: unknown }>; changes: Array<{ observedAtUtc: string; value: unknown }> }> }
    const signal = history.signals.find(({ canonicalId }) => canonicalId === flag.canonicalId)
    const trace = (signal?.samples ?? []).filter(({ observedAtUtc }) => Date.parse(observedAtUtc) >= Date.parse(stable.fromUtc) && Date.parse(observedAtUtc) <= Date.parse(stable.toUtc))
    const active = history.signals.find(({ canonicalId }) => canonicalId === 'deck.active')
    const activeEvidence = active ? { seed: active.seed, changes: active.changes.filter(({ observedAtUtc }) => Date.parse(observedAtUtc) >= Date.parse(stable.fromUtc) && Date.parse(observedAtUtc) <= Date.parse(stable.toUtc)) } : null
    const knownInactive = activeEvidence?.changes.at(-1)?.value === 0 || activeEvidence?.changes.at(-1)?.value === false || (!activeEvidence?.changes.length && (activeEvidence?.seed?.value === 0 || activeEvidence?.seed?.value === false))
    const qa = knownInactive ? 'MISLEADING' : trace.length < 3 ? 'INSUFFICIENT' : flag.current.median === 0 && flag.deckNumber !== null && !activeEvidence?.seed ? 'PLAUSIBLE BUT WEAK' : flag.robustDeviation >= 4 && trace.length >= 5 ? 'USEFUL' : 'PLAUSIBLE BUT WEAK'
    reviewed.push({ pressKey: occurrence.pressKey, occurrenceId: occurrence.occurrenceId, startUtc: occurrence.startUtc, exactIdentities: occurrence.exactIdentities, canonicalId: flag.canonicalId, deckNumber: flag.deckNumber, current: flag.current, reference: flag.reference, robustDeviation: flag.robustDeviation, trace, deckActiveEvidence: activeEvidence, qa, rationale: knownInactive ? 'Explicit deck.active evidence was inactive; automatic surfacing should have excluded this identity.' : flag.current.median === 0 && flag.deckNumber !== null && !activeEvidence?.seed ? 'The raw zero excursion is real, but deck-state evidence is unavailable, so interpretation remains weak.' : qa === 'USEFUL' ? 'The timestamped trace has at least five observations and a strong same-speed robust deviation.' : 'The strict heuristic qualifies, but trace support or effect strength remains modest.' })
  }
  const counts = Object.fromEntries(['USEFUL', 'PLAUSIBLE BUT WEAK', 'MISLEADING', 'INSUFFICIENT'].map((qa) => [qa, reviewed.filter((item) => item.qa === qa).length]))
  await writeFile(output, `${JSON.stringify({ generatedAtUtc: new Date().toISOString(), source: artifact.toString(), counts, reviewed }, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(counts)}\n`)
}

void main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1 })
