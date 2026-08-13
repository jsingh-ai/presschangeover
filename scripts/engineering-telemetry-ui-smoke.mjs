import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const debuggerUrl = process.argv[2] ?? 'http://127.0.0.1:9222'
const applicationUrl = process.argv[3] ?? 'http://127.0.0.1:8100'
const screenshotDirectory = process.argv[4]
const auditPath = process.argv[5] ?? 'review-artifacts/engineering-telemetry-phase2/real-data-performance.json'
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const audit = JSON.parse(await readFile(auditPath, 'utf8'))

async function pageTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { const targets = await fetch(`${debuggerUrl}/json/list`).then((response) => response.json()); const target = targets.find(({ type }) => type === 'page'); if (target) return target } catch {}
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
  if (message.id) { const handler = pending.get(message.id); if (!handler) return; pending.delete(message.id); if (message.error) handler.reject(new Error(message.error.message)); else handler.resolve(message.result) }
  else if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
  else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params.args.map(({ value, description }) => value ?? description).join(' '))
})
function command(method, params = {}) { const id = nextId++; socket.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => pending.set(id, { resolve, reject })) }
async function evaluate(expression) { const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value }
async function waitFor(expression, label, attempts = 320) { for (let attempt = 0; attempt < attempts; attempt += 1) { try { if (await evaluate(expression)) return } catch {}; await delay(250) }; throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(await evaluate(`({ href: location.href, statuses: [...document.querySelectorAll('[role=status]')].map(x => x.textContent), warnings: [...document.querySelectorAll('.message--warning')].map(x => x.textContent), text: document.body.innerText.slice(0, 1500) })`))}`) }
async function setTheme(theme) { if (await evaluate('document.documentElement.dataset.theme') !== theme) await evaluate(`document.querySelector('.theme-toggle')?.click()`); await waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`, `${theme} theme`) }
async function capture(name) { if (!screenshotDirectory) return; const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(join(screenshotDirectory, `${name}.png`), Buffer.from(shot.data, 'base64')) }
async function navigate(url, ready = `Boolean(document.querySelector('.engineering-signal-list > article'))`) { await command('Page.navigate', { url }); await waitFor(`document.readyState === 'complete' && ${ready}`, 'Engineering Telemetry Inspector') }

await command('Page.enable'); await command('Runtime.enable'); await command('Performance.enable')
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true })
await command('Page.addScriptToEvaluateOnNewDocument', { source: `{
  const actualFetch = window.fetch.bind(window); window.__engineeringRequests = [];
  window.fetch = async (input, init) => { const url = String(input instanceof Request ? input.url : input); const tracked = url.includes('/semantic-history'); const started = performance.now(); let record;
    if (tracked) { let selectors = 0; try { selectors = JSON.parse(String(init?.body ?? '{}')).signals?.length ?? 0 } catch {}; record = { url, selectors, started, state: 'active' }; window.__engineeringRequests.push(record) }
    try { const response = await actualFetch(input, init); if (record) { record.state = 'complete'; record.status = response.status; record.latencyMs = performance.now() - started; response.clone().text().then((text) => { record.bytes = new TextEncoder().encode(text).length }) }; return response }
    catch (error) { if (record) { record.state = error?.name === 'AbortError' ? 'aborted' : 'error'; record.latencyMs = performance.now() - started }; throw error }
  }
}` })

const query = new URLSearchParams({ preset: 'custom', fromUtc: '2026-08-12T17:00:00.000Z', toUtc: '2026-08-13T17:00:00.000Z', press: 'press5', activityLevel: 'process_family', activityKey: 'CLEANING_WASH', activityGroup: 'ROUTINE_PROCESS' })
const mainUrl = `${applicationUrl}/operational-analysis?${query}`
const initialStarted = performance.now()
await navigate(mainUrl)
await waitFor(`Boolean(document.querySelector('.telemetry-clue-window')) && Boolean(document.querySelector('.engineering-scope-tabs'))`, 'clues and inspector')

const report = { matrix: {}, integration: {}, performance: {}, noClue: {}, degraded: {}, consoleErrors }
report.performance.firstUsableInspectorMs = Number((performance.now() - initialStarted).toFixed(1))
for (const { name, width, height } of [{ name: '1600', width: 1600, height: 1050 }, { name: '1440', width: 1440, height: 1000 }, { name: '1200', width: 1200, height: 900 }, { name: '768', width: 768, height: 1024 }, { name: '390', width: 390, height: 844 }]) {
  report.matrix[name] = {}
  await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  await evaluate(`document.querySelector('.engineering-inspector')?.scrollIntoView({ block: 'start' })`); await delay(150)
  for (const theme of ['light', 'dark']) {
    await setTheme(theme)
    const result = await evaluate(`(() => { const panel = document.querySelector('.engineering-inspector'); const scopes = document.querySelector('.engineering-scope-tabs'); return { theme: document.documentElement.dataset.theme, pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, panelContained: panel.getBoundingClientRect().left >= -1 && panel.getBoundingClientRect().right <= document.documentElement.clientWidth + 1, scopeContained: scopes.getBoundingClientRect().left >= panel.getBoundingClientRect().left - 1 && scopes.getBoundingClientRect().right <= panel.getBoundingClientRect().right + 1, scopeButtons: scopes.querySelectorAll('button').length, selectedScopes: scopes.querySelectorAll('[aria-selected=true]').length, categories: document.querySelectorAll('.engineering-category-tabs button').length, signals: document.querySelectorAll('.engineering-signal-list > article').length } })()`)
    if (result.pageOverflow || !result.panelContained || !result.scopeContained || result.scopeButtons !== 11 || result.selectedScopes !== 1 || result.categories < 1 || result.signals < 1) throw new Error(`Responsive inspector layout failed ${name}/${theme}: ${JSON.stringify(result)}`)
    report.matrix[name][theme] = result; await capture(`${name}-${theme}-engineering-inspector`)
  }
}

await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await setTheme('light')
const clueName = await evaluate(`document.querySelector('.signal-clue-grid h4')?.textContent`)
await evaluate(`document.querySelector('.signal-clue-grid footer .secondary-action')?.click()`)
await waitFor(`Boolean(document.querySelector('.engineering-selected-trace .synchronized-timeline')) && Boolean(document.querySelector('.engineering-signal-list > article.is-highlighted'))`, 'clue to detailed trace')
report.integration.clueToInspector = await evaluate(`({ clue: ${JSON.stringify(clueName)}, selectedScope: document.querySelector('.engineering-scope-tabs [aria-selected=true] strong')?.textContent, selectedCategory: document.querySelector('.engineering-category-tabs .is-selected')?.textContent, highlighted: document.querySelector('.engineering-signal-list > article.is-highlighted code')?.textContent, detailedTrace: Boolean(document.querySelector('.engineering-selected-trace .synchronized-timeline')) })`)
await evaluate(`document.querySelector('.signal-clue-grid footer button:last-child')?.click()`)
await waitFor(`document.querySelectorAll('.engineering-pin-chips > span').length === 1`, 'clue pin')
report.integration.cluePin = await evaluate(`document.querySelector('.engineering-pin-chips')?.textContent`)

async function restorePins(pins, expected, label) {
  const started = performance.now()
  await evaluate(`sessionStorage.setItem('process-intelligence.engineering-telemetry-pins.v1', ${JSON.stringify(JSON.stringify(pins.map(({ canonicalId, deckNumber }) => ({ canonicalId, ...(deckNumber === undefined ? {} : { deckNumber }) }))))})`)
  await navigate(mainUrl)
  await waitFor(`document.querySelectorAll('.engineering-pin-chips > span').length === ${expected} && !document.querySelector('.engineering-pins .scope-progress')`, `${label} restored pins`)
  await waitFor(`window.__engineeringRequests.every((item) => item.state !== 'active')`, `${label} request completion`)
  await delay(200)
  return { ...(await evaluate(`({ pins: document.querySelectorAll('.engineering-pin-chips > span').length, numericRows: document.querySelectorAll('.engineering-pins .synchronized-timeline__row--numeric').length, intervalRows: document.querySelectorAll('.engineering-pins .synchronized-timeline__track').length, eventRows: document.querySelectorAll('.engineering-pins .synchronized-timeline__row--events').length, crosshairValues: document.querySelectorAll('.engineering-pins .engineering-crosshair-readout article').length, requests: window.__engineeringRequests })`)), renderedMs: Number((performance.now() - started).toFixed(1)) }
}
report.performance.fivePins = await restorePins(audit.presses.press5.fivePins.selectors, 5, 'five-pin')
report.performance.twelvePins = await restorePins(audit.presses.press5.twelvePins.selectors, 12, 'twelve-pin')
const browserMetrics = await command('Performance.getMetrics')
report.performance.browserMetrics = Object.fromEntries(browserMetrics.metrics.filter(({ name }) => ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'Documents'].includes(name)).map(({ name, value }) => [name, value]))
if (report.performance.fivePins.crosshairValues !== 5 || report.performance.twelvePins.crosshairValues !== 12 || report.performance.twelvePins.numericRows + report.performance.twelvePins.intervalRows < 12) throw new Error(`Pinned trace rendering failed: ${JSON.stringify(report.performance)}`)
const beforeInspection = await evaluate(`document.querySelector('.engineering-pins .engineering-crosshair-readout h4')?.textContent`)
await evaluate(`(() => { const timeline = document.querySelector('.engineering-pins .synchronized-timeline__scroll'); timeline.focus(); timeline.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })()`)
await waitFor(`document.querySelector('.engineering-pins .engineering-crosshair-readout h4')?.textContent !== ${JSON.stringify(beforeInspection)}`, 'keyboard crosshair')
report.integration.keyboardCrosshair = { before: beforeInspection, after: await evaluate(`document.querySelector('.engineering-pins .engineering-crosshair-readout h4')?.textContent`), values: await evaluate(`document.querySelectorAll('.engineering-pins .engineering-crosshair-readout article').length`) }

const pinLabelsBeforeNext = await evaluate(`[...document.querySelectorAll('.engineering-pin-chips > span')].map((item) => item.childNodes[0].textContent.trim())`)
await evaluate(`document.querySelector('.occurrence-navigation button:last-child')?.click()`)
await waitFor(`document.querySelectorAll('.engineering-pin-chips > span').length === 12 && Boolean(document.querySelector('.telemetry-clue-window'))`, 'next occurrence pins')
report.integration.nextOccurrence = { pinsBefore: pinLabelsBeforeNext, pinsAfter: await evaluate(`[...document.querySelectorAll('.engineering-pin-chips > span')].map((item) => item.childNodes[0].textContent.trim())`), focusedOccurrence: await evaluate(`document.querySelector('.telemetry-clues')?.dataset.focusedOccurrenceId`), unavailablePins: await evaluate(`document.querySelectorAll('.engineering-pin-chips > span.is-unavailable').length`) }
if (JSON.stringify(report.integration.nextOccurrence.pinsBefore) !== JSON.stringify(report.integration.nextOccurrence.pinsAfter)) throw new Error('Pins changed during Next occurrence')
await evaluate(`document.querySelector('.engineering-pins')?.scrollIntoView({ block: 'start' })`); await delay(150); await capture('1440-light-twelve-pinned-signals')

const noClueQuery = new URLSearchParams({ preset: 'custom', fromUtc: '2026-08-06T07:30:00.000Z', toUtc: '2026-08-06T09:00:00.000Z', press: 'press14', activityLevel: 'exact_status', activityKey: 'B\u001f95\u001fPress Problem / Impression' })
await evaluate(`sessionStorage.setItem('process-intelligence.engineering-telemetry-pins.v1', '[]')`)
await navigate(`${applicationUrl}/operational-analysis?${noClueQuery}`)
await waitFor(`document.body.textContent.includes('No strong telemetry clue was identified') && Boolean(document.querySelector('.engineering-signal-list > article'))`, 'no-clue manual browser')
report.noClue = await evaluate(`({ message: [...document.querySelectorAll('.engineering-inspector .message')].map(x => x.textContent).find(x => x.includes('No strong telemetry clue')), scopeButtons: document.querySelectorAll('.engineering-scope-tabs button').length, categories: document.querySelectorAll('.engineering-category-tabs button').length, signals: document.querySelectorAll('.engineering-signal-list > article').length, inspectEnabled: !document.querySelector('.engineering-signal-list footer .secondary-action')?.disabled })`)
await evaluate(`document.querySelector('.engineering-inspector')?.scrollIntoView({ block: 'start' })`); await delay(150); await capture('1440-light-no-clue-manual-browser')

const interception = await command('Page.addScriptToEvaluateOnNewDocument', { source: `{ const actual = window.fetch.bind(window); window.fetch = (input, init) => String(input instanceof Request ? input.url : input).includes('/semantic-history') ? Promise.resolve(new Response('{"error":"simulated"}', { status: 503, headers: { 'content-type': 'application/json' } })) : actual(input, init) }` })
await navigate(mainUrl, `document.body.textContent.includes('Temporarily unavailable') && Boolean(document.querySelector('.physical-signature-summary'))`)
report.degraded = await evaluate(`({ signalErrors: [...document.querySelectorAll('.engineering-signal-list dd')].filter(x => x.textContent.includes('Temporarily unavailable')).length, signature: Boolean(document.querySelector('.physical-signature-summary')), occurrences: Boolean(document.querySelector('.activity-evidence')), fatal: Boolean(document.querySelector('.unavailable-panel')) })`)
await command('Page.removeScriptToEvaluateOnNewDocument', { identifier: interception.identifier })

if (consoleErrors.length) throw new Error(`Browser console errors: ${consoleErrors.join(' | ')}`)
if (screenshotDirectory) await writeFile(join(screenshotDirectory, 'browser-validation.json'), JSON.stringify(report, null, 2))
socket.close(); console.log(JSON.stringify(report, null, 2))
