import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const debuggerUrl = process.argv[2] ?? 'http://127.0.0.1:9223'
const applicationUrl = process.argv[3] ?? 'http://127.0.0.1:8100'
const screenshotDirectory = process.argv[4] ?? 'review-artifacts/phase3-stop-restart/screenshots'
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const targets = {
  mechanical: { pressKey: 'press5', occurrenceStartUtc: '2026-08-13T14:58:05.829Z' },
  failedRestart: { pressKey: 'press13', occurrenceStartUtc: '2026-08-13T08:32:52.058Z' },
  highSpeed: { pressKey: 'press15', occurrenceStartUtc: '2026-08-13T14:07:40.579Z' },
  noStop: { pressKey: 'press15', occurrenceStartUtc: '2026-08-13T16:54:41.883Z' },
  radiusTiming: { pressKey: 'press5', occurrenceStartUtc: '2026-08-13T15:28:25.063Z' },
}
const fromUtc = '2026-08-12T17:00:00.000Z'; const toUtc = '2026-08-13T17:00:00.000Z'

async function targetPage() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { const pages = await fetch(`${debuggerUrl}/json/list`).then((response) => response.json()); const page = pages.find(({ type }) => type === 'page'); if (page) return page } catch {}
    await delay(250)
  }
  throw new Error('Browser debugger page unavailable')
}
const page = await targetPage(); const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
let id = 0; const pending = new Map(); const consoleErrors = []
socket.addEventListener('message', ({ data }) => { const message = JSON.parse(data); if (message.id) { const item = pending.get(message.id); if (!item) return; pending.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result) } else if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(message.params.exceptionDetails.text); else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params.args.map(({ value, description }) => value ?? description).join(' ')) })
const command = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })) })
async function evaluate(expression) { const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value }
async function waitFor(expression, label, attempts = 720) { for (let attempt = 0; attempt < attempts; attempt += 1) { try { if (await evaluate(expression)) return } catch {}; await delay(250) } throw new Error(`Timed out waiting for ${label}`) }
async function capture(name) { const value = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(join(screenshotDirectory, `${name}.png`), Buffer.from(value.data, 'base64')) }
async function theme(value) { if (await evaluate('document.documentElement.dataset.theme') !== value) await evaluate(`document.querySelector('.theme-toggle')?.click()`); await waitFor(`document.documentElement.dataset.theme === '${value}'`, `${value} theme`) }

async function selectOccurrence({ pressKey, occurrenceStartUtc }) {
  const query = new URLSearchParams({ preset: 'custom', fromUtc, toUtc, press: pressKey, activityLevel: 'radius_state', activityKey: 'B' })
  await command('Page.navigate', { url: `${applicationUrl}/operational-analysis?${query}` })
  await waitFor(`document.querySelectorAll('.activity-evidence tbody tr').length > 0`, `${pressKey} occurrences`)
  const index = await evaluate(`fetch('/api/radius/activity-analysis?${new URLSearchParams({ fromUtc, toUtc, pressKey, level: 'radius_state', key: 'B', evidenceOffset: '0' })}').then(r=>r.json()).then(v=>v.occurrences.findIndex(x=>x.startUtc===${JSON.stringify(occurrenceStartUtc)}))`)
  if (index < 0) throw new Error(`Occurrence at ${occurrenceStartUtc} was not loaded`)
  await evaluate(`document.querySelectorAll('.activity-evidence tbody tr')[${index}]?.click()`)
  await waitFor(`Boolean(document.querySelector('.stop-restart-analysis[data-stop-match]'))`, occurrenceStartUtc)
  return evaluate(`({ match: document.querySelector('.stop-restart-analysis')?.dataset.stopMatch, title: document.querySelector('.focused-occurrence-facts')?.textContent, flags: document.querySelectorAll('.prestop-flag-grid > article').length, attempts: document.querySelectorAll('.restart-attempts > li').length, highSpeed: document.querySelector('.stop-speed-current')?.textContent.includes('HIGH-SPEED RUNNING'), radiusTiming: Boolean(document.querySelector('.radius-timing-context')) })`)
}

await command('Page.enable'); await command('Runtime.enable'); await mkdir(screenshotDirectory, { recursive: true })
const report = { responsive: {}, scenarios: {}, interaction: {}, consoleErrors }
report.scenarios.mechanical = await selectOccurrence(targets.mechanical)
for (const { width, height } of [{ width: 1600, height: 1050 }, { width: 1440, height: 1000 }, { width: 1200, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
  report.responsive[width] = {}
  await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width === 390 })
  for (const color of ['light', 'dark']) {
    await theme(color); await evaluate(`document.querySelector('.stop-restart-analysis')?.scrollIntoView({block:'start'})`); await delay(150)
    const result = await evaluate(`(() => { const panel=document.querySelector('.stop-restart-analysis'); return { pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, panelContained: panel.getBoundingClientRect().left >= -1 && panel.getBoundingClientRect().right <= document.documentElement.clientWidth + 1, timeline: Boolean(panel.querySelector('.synchronized-timeline')), buttonsLabelled: [...panel.querySelectorAll('button')].every(button=>button.textContent.trim() || button.getAttribute('aria-label')), theme: document.documentElement.dataset.theme } })()`)
    if (result.pageOverflow || !result.panelContained || !result.buttonsLabelled) throw new Error(`Responsive failure ${width}/${color}: ${JSON.stringify(result)}`)
    report.responsive[width][color] = result; await capture(`${width}-${color}-mechanical-stop`)
  }
}

await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await theme('light')
report.scenarios.failedRestart = await selectOccurrence(targets.failedRestart); await evaluate(`document.querySelector('.restart-attempts')?.scrollIntoView({block:'center'})`); await delay(100); await capture('failed-restart-attempts')
report.scenarios.highSpeed = await selectOccurrence(targets.highSpeed); await evaluate(`document.querySelector('.stop-speed-current')?.scrollIntoView({block:'center'})`); await delay(100); await capture('high-speed-context')
report.scenarios.noStop = await selectOccurrence(targets.noStop); await evaluate(`document.querySelector('.stop-restart-analysis')?.scrollIntoView({block:'start'})`); await delay(100); await capture('no-physical-stop-match')
report.scenarios.radiusTiming = await selectOccurrence(targets.radiusTiming); await waitFor(`!document.querySelector('.radius-timing-context .scope-progress')`, 'Radius aggregate timing'); await evaluate(`document.querySelector('.radius-timing-context')?.scrollIntoView({block:'center'})`); await delay(100); await capture('radius-timing-context')
report.interaction.keyboard = await evaluate(`(() => { const target=document.querySelector('.stop-restart-analysis .synchronized-timeline [tabindex="0"]') ?? document.querySelector('.stop-restart-analysis button'); target?.focus(); return { focused: Boolean(target && document.activeElement===target), label: target?.getAttribute('aria-label') ?? target?.textContent?.trim() } })()`)
report.interaction.previousNext = await evaluate(`({ previous: !document.querySelector('.occurrence-navigation button:first-child')?.disabled, next: !document.querySelector('.occurrence-navigation button:last-child')?.disabled })`)
if (!report.interaction.keyboard.focused || consoleErrors.length) throw new Error(`Browser interaction or console failure: ${JSON.stringify({ interaction: report.interaction, consoleErrors })}`)
await writeFile(join(screenshotDirectory, 'browser-validation.json'), `${JSON.stringify(report, null, 2)}\n`)
socket.close(); console.log(JSON.stringify(report))
