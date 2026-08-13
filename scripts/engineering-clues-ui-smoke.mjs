import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const debuggerUrl = process.argv[2] ?? 'http://127.0.0.1:9222'
const applicationUrl = process.argv[3] ?? 'http://127.0.0.1:8100'
const screenshotDirectory = process.argv[4]
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function pageTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const targets = await fetch(`${debuggerUrl}/json/list`).then((response) => response.json())
      const target = targets.find(({ type }) => type === 'page')
      if (target) return target
    } catch {}
    await delay(250)
  }
  throw new Error('Browser debugger page unavailable')
}

const target = await pageTarget()
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
let nextId = 1
const pending = new Map()
const consoleErrors = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id) {
    const handler = pending.get(message.id)
    if (!handler) return
    pending.delete(message.id)
    if (message.error) handler.reject(new Error(message.error.message)); else handler.resolve(message.result)
  } else if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(message.params.exceptionDetails.text)
  else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params.args.map(({ value, description }) => value ?? description).join(' '))
})
function command(method, params = {}) { const id = nextId++; socket.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => pending.set(id, { resolve, reject })) }
async function evaluate(expression) { const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value }
async function waitFor(expression, label, attempts = 240) { for (let attempt = 0; attempt < attempts; attempt += 1) { try { if (await evaluate(expression)) return } catch {}; await delay(250) }; const state = await evaluate(`({ path: location.href, title: document.querySelector('h1')?.textContent, warnings: [...document.querySelectorAll('.message--warning,.unavailable-panel')].map((item) => item.textContent), statuses: [...document.querySelectorAll('[role=status]')].map((item) => item.textContent), body: document.body.innerText.slice(0, 1200) })`); throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(state)}`) }
async function setTheme(theme) { if (await evaluate('document.documentElement.dataset.theme') !== theme) await evaluate(`document.querySelector('.theme-toggle')?.click()`); await waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`, `${theme} theme`) }
async function capture(name) { if (!screenshotDirectory) return; const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(join(screenshotDirectory, `${name}.png`), Buffer.from(shot.data, 'base64')) }

await command('Page.enable')
await command('Runtime.enable')
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true })
const query = new URLSearchParams({ preset: 'custom', fromUtc: '2026-08-06T15:18:00.000Z', toUtc: '2026-08-13T15:18:00.000Z', press: 'press5', activityLevel: 'operational_group', activityKey: 'MAINTENANCE_INTERVENTION' })
let initialReady = false
for (let attempt = 0; attempt < 4 && !initialReady; attempt += 1) {
  await command('Page.navigate', { url: `${applicationUrl}/operational-analysis?${query}` })
  for (let poll = 0; poll < 80; poll += 1) {
    initialReady = await evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('.telemetry-clues .telemetry-clue-window'))`)
    if (initialReady || await evaluate(`Boolean(document.querySelector('.unavailable-panel'))`)) break
    await delay(250)
  }
  if (!initialReady) await delay(750)
}
if (!initialReady) throw new Error('Could not load real telemetry clues after four attempts')

const report = { matrix: {}, interaction: {}, degraded: {}, consoleErrors }
for (const { name, width, height } of [
  { name: '1600', width: 1600, height: 1050 }, { name: '1440', width: 1440, height: 1000 }, { name: '1200', width: 1200, height: 900 }, { name: '768', width: 768, height: 1024 }, { name: '390', width: 390, height: 844 },
]) {
  report.matrix[name] = {}
  await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  await evaluate(`document.querySelector('.telemetry-clues')?.scrollIntoView({ block: 'start' })`)
  await delay(150)
  for (const theme of ['light', 'dark']) {
    await setTheme(theme)
    const result = await evaluate(`(() => {
      const panel = document.querySelector('.telemetry-clues')
      const map = document.querySelector('.telemetry-map-scroll')
      return {
        theme: document.documentElement.dataset.theme,
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        panelContained: panel.getBoundingClientRect().left >= -1 && panel.getBoundingClientRect().right <= document.documentElement.clientWidth + 1,
        mapContained: map.getBoundingClientRect().left >= -1 && map.getBoundingClientRect().right <= document.documentElement.clientWidth + 1,
        rows: document.querySelectorAll('.telemetry-change-map tbody tr').length,
        columns: document.querySelectorAll('.telemetry-change-map thead th').length,
        clues: document.querySelectorAll('.signal-clue-grid > article').length,
        focusableCells: document.querySelectorAll('.telemetry-map-cell[tabindex="0"]').length,
        totalCells: document.querySelectorAll('.telemetry-map-cell').length,
        labelledCells: document.querySelectorAll('.telemetry-map-cell[aria-label]').length,
      }
    })()`)
    if (result.pageOverflow || !result.panelContained || !result.mapContained || result.rows !== 11 || result.columns < 2 || result.focusableCells !== 1 || result.labelledCells !== result.totalCells) throw new Error(`Responsive clue layout failed at ${name}/${theme}: ${JSON.stringify(result)}`)
    report.matrix[name][theme] = result
    await capture(`${name}-${theme}-telemetry-clues`)
  }
}

await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
await setTheme('light')
report.interaction.matrixKeyboard = await evaluate(`(() => { const before = document.querySelector('.telemetry-map-cell[tabindex="0"]'); before.focus(); const beforeLabel = before.getAttribute('aria-label'); before.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); const after = document.activeElement; return { beforeLabel, afterLabel: after.getAttribute('aria-label'), moved: before !== after, tabStops: document.querySelectorAll('.telemetry-map-cell[tabindex="0"]').length, visibleFocusTarget: after.classList.contains('telemetry-map-cell') } })()`)
if (!report.interaction.matrixKeyboard.moved || report.interaction.matrixKeyboard.tabStops !== 1 || !report.interaction.matrixKeyboard.visibleFocusTarget) throw new Error(`Matrix keyboard navigation failed: ${JSON.stringify(report.interaction.matrixKeyboard)}`)

await evaluate(`fetch('/api/review-engineering-clue-metrics', { method: 'POST' })`)
let rapidStartReady = false
for (let attempt = 0; attempt < 4 && !rapidStartReady; attempt += 1) {
  await command('Page.navigate', { url: `${applicationUrl}/operational-analysis?${query}` })
  for (let poll = 0; poll < 40; poll += 1) {
    rapidStartReady = await evaluate(`Boolean(document.querySelector('.focused-occurrence-facts')) && !document.querySelector('.occurrence-navigation button:last-child')?.disabled`)
    if (rapidStartReady || await evaluate(`Boolean(document.querySelector('.unavailable-panel'))`)) break
    await delay(250)
  }
  if (!rapidStartReady) await delay(750)
}
if (!rapidStartReady) throw new Error('Could not load an operational occurrence for rapid switching after four attempts')
const rapidStates = [await evaluate(`(() => { const panel = document.querySelector('.telemetry-clues'); return { text: document.querySelectorAll('.focused-occurrence-facts dd')[2]?.textContent, focusedId: panel?.dataset.focusedOccurrenceId, clueId: panel?.dataset.clueOccurrenceId, mismatch: Boolean(panel?.dataset.clueOccurrenceId && panel.dataset.clueOccurrenceId !== panel.dataset.focusedOccurrenceId) } })()`)]
for (let index = 0; index < 3; index += 1) {
  const moved = await evaluate(`(async () => { const button = document.querySelector('.occurrence-navigation button:last-child'); if (!button || button.disabled) return null; button.click(); await new Promise((resolve) => setTimeout(resolve, 75)); const panel = document.querySelector('.telemetry-clues'); return { text: document.querySelectorAll('.focused-occurrence-facts dd')[2]?.textContent, focusedId: panel?.dataset.focusedOccurrenceId, clueId: panel?.dataset.clueOccurrenceId, mismatch: Boolean(panel?.dataset.clueOccurrenceId && panel.dataset.clueOccurrenceId !== panel.dataset.focusedOccurrenceId) } })()`)
  if (!moved) break
  rapidStates.push(moved)
}
const rapidOccurrences = rapidStates.map(({ text }) => text)
if (rapidOccurrences.length !== 4 || new Set(rapidOccurrences).size !== 4) throw new Error(`Could not exercise A→B→C→D switching: ${JSON.stringify(rapidStates)}`)
const finalRapidOccurrence = rapidOccurrences.at(-1)
await waitFor(`Boolean(document.querySelector('.telemetry-clues .telemetry-clue-window')) && !document.querySelector('.telemetry-clues .scope-progress') && document.querySelectorAll('.focused-occurrence-facts dd')[2]?.textContent === ${JSON.stringify(finalRapidOccurrence)}`, 'final rapid-switch occurrence clues')
await waitFor(`fetch('/api/review-engineering-clue-metrics').then((response) => response.json()).then((value) => value.activeClues === 0 && value.activeSemantic === 0)`, 'rapid-switch request cleanup')
const rapidMetrics = await evaluate(`fetch('/api/review-engineering-clue-metrics').then((response) => response.json())`)
const finalIdentity = await evaluate(`(() => { const panel = document.querySelector('.telemetry-clues'); return { focusedId: panel?.dataset.focusedOccurrenceId, clueId: panel?.dataset.clueOccurrenceId } })()`)
report.interaction.rapidSwitching = { occurrences: rapidOccurrences, finalOccurrence: finalRapidOccurrence, finalOccurrenceStillShown: await evaluate(`document.querySelectorAll('.focused-occurrence-facts dd')[2]?.textContent === ${JSON.stringify(finalRapidOccurrence)}`), finalIdentity, staleClueFlash: rapidStates.some(({ mismatch }) => mismatch), metrics: rapidMetrics }
if (!report.interaction.rapidSwitching.finalOccurrenceStillShown || finalIdentity.focusedId !== finalIdentity.clueId || report.interaction.rapidSwitching.staleClueFlash || rapidMetrics.clueStarted < 4 || rapidMetrics.clueCompleted < 1 || rapidMetrics.clueAborted < 1 || rapidMetrics.clueCompleted + rapidMetrics.clueAborted < rapidMetrics.clueStarted || rapidMetrics.activeClues !== 0 || rapidMetrics.activeSemantic !== 0 || rapidMetrics.maxActiveClues > 2 || rapidMetrics.maxActiveSemantic > 6) throw new Error(`Rapid switching cancellation failed: ${JSON.stringify(report.interaction.rapidSwitching)}`)

report.interaction.navigation = { nextEnabled: true, changed: rapidOccurrences.length === 4, previousEnabledAfterNext: await evaluate(`!document.querySelector('.occurrence-navigation button:first-child')?.disabled`) }

for (let attempt = 0; attempt < 12 && !(await evaluate(`Boolean(document.querySelector('.signal-clue-grid button'))`)); attempt += 1) {
  const canAdvance = await evaluate(`!document.querySelector('.occurrence-navigation button:last-child')?.disabled`)
  if (!canAdvance) break
  await evaluate(`document.querySelector('.occurrence-navigation button:last-child')?.click()`)
  await waitFor(`Boolean(document.querySelector('.telemetry-clues .telemetry-clue-window')) && !document.querySelector('.telemetry-clues .scope-progress')`, `clue occurrence ${attempt + 1}`)
}
const viewTraceAvailable = await evaluate(`Boolean(document.querySelector('.signal-clue-grid button'))`)
if (viewTraceAvailable) {
  const selectedClue = await evaluate(`document.querySelector('.signal-clue-grid > article h4')?.textContent`)
  await evaluate(`document.querySelector('.signal-clue-grid button')?.click()`)
  await waitFor(`Boolean(document.querySelector('.telemetry-trace-viewer .synchronized-timeline')) || Boolean(document.querySelector('.telemetry-trace-viewer .message--warning'))`, 'View Trace')
  report.interaction.viewTrace = await evaluate(`(() => { const viewer = document.querySelector('.telemetry-trace-viewer'); const labels = [...viewer.querySelectorAll('[aria-label]')].map((item) => item.getAttribute('aria-label')); return { clue: ${JSON.stringify(selectedClue)}, error: Boolean(viewer.querySelector('.message--warning')), timeline: Boolean(viewer.querySelector('.synchronized-timeline')), occurrenceMarkers: labels.includes('Occurrence reference event markers'), motion: labels.includes('Physical Motion intervals'), numeric: labels.some((label) => label?.includes('observed samples')), rawEvents: labels.some((label) => label?.endsWith('event markers')) } })()`)
  if (report.interaction.viewTrace.error || !report.interaction.viewTrace.timeline || !report.interaction.viewTrace.occurrenceMarkers) throw new Error(`View Trace failed: ${JSON.stringify(report.interaction.viewTrace)}`)
  await evaluate(`document.querySelector('.telemetry-trace-viewer')?.scrollIntoView({ block: 'start' })`)
  await delay(150)
  await capture('1440-light-view-trace')
}
report.interaction.summary = await evaluate(`({ whereToLook: document.querySelectorAll('.where-to-look-grid article').length, firstChangeGroups: document.querySelectorAll('.first-change-groups article').length, clueCards: document.querySelectorAll('.signal-clue-grid > article').length, unsupported: document.querySelectorAll('.telemetry-map-cell--unsupported').length, windowCopy: document.querySelector('.telemetry-clue-window')?.textContent, coverage: document.querySelector('.telemetry-clue-coverage')?.textContent })`)

const interception = await command('Page.addScriptToEvaluateOnNewDocument', { source: `{ const actual = window.fetch.bind(window); window.fetch = (input, init) => String(input instanceof Request ? input.url : input).endsWith('/clues') ? Promise.resolve(new Response('{"error":"simulated"}', { status: 503, headers: { 'content-type': 'application/json' } })) : actual(input, init) }` })
await command('Page.navigate', { url: `${applicationUrl}/operational-analysis?${query}` })
await waitFor(`document.body.textContent.includes('Telemetry clues are temporarily unavailable') && Boolean(document.querySelector('.physical-signature-summary')) && Boolean(document.querySelector('.activity-evidence'))`, 'clue outage fallback')
report.degraded = await evaluate(`({ warning: document.querySelector('.telemetry-clues .message--warning')?.textContent, signature: Boolean(document.querySelector('.physical-signature-summary')), occurrences: Boolean(document.querySelector('.activity-evidence')), fatal: Boolean(document.querySelector('.unavailable-panel')) })`)
await command('Page.removeScriptToEvaluateOnNewDocument', { identifier: interception.identifier })

if (consoleErrors.length) throw new Error(`Browser console errors: ${consoleErrors.join(' | ')}`)
if (screenshotDirectory) await writeFile(join(screenshotDirectory, 'browser-validation.json'), JSON.stringify(report, null, 2))
socket.close()
console.log(JSON.stringify(report, null, 2))
