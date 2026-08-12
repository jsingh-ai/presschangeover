import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const debuggerUrl = process.argv[2] ?? 'http://127.0.0.1:9222'
const applicationUrl = process.argv[3] ?? 'http://10.8.10.97:8088/overview'
const screenshotDirectory = process.argv[4]
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function pageTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const targets = await fetch(`${debuggerUrl}/json/list`).then((response) => response.json())
      const target = targets.find(({ type }) => type === 'page')
      if (target) return target
    } catch {}
    await delay(250)
  }
  throw new Error('Edge remote-debugging page was not available')
}

const target = await pageTarget()
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (!message.id) return
  const handler = pending.get(message.id)
  if (!handler) return
  pending.delete(message.id)
  if (message.error) handler.reject(new Error(message.error.message))
  else handler.resolve(message.result)
})

function command(method, params = {}) {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}

async function waitFor(expression, label) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { if (await evaluate(expression)) return } catch {}
    await delay(250)
  }
  const state = await evaluate(`({ path: location.pathname, title: document.querySelector('h1')?.textContent, loading: document.querySelector('[role=status]')?.textContent, error: document.querySelector('.unavailable-panel')?.textContent })`)
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(state)}`)
}

async function navigate(url, readyExpression, label) {
  await command('Page.navigate', { url })
  await waitFor(`document.readyState === 'complete' && (${readyExpression})`, label)
}

async function capture(name) {
  if (!screenshotDirectory) return
  const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(join(screenshotDirectory, `${name}.png`), Buffer.from(screenshot.data, 'base64'))
}

await command('Page.enable')
await command('Runtime.enable')
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true })

const report = { viewports: {}, regressions: {} }
for (const viewport of [
  { name: 'desktop-1600', width: 1600, height: 1050 },
  { name: 'desktop-1440', width: 1440, height: 1000 },
  { name: 'desktop-1200', width: 1200, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  await command('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.width < 600 })
  await navigate(applicationUrl, `Boolean(document.querySelector('.overview-snapshot'))`, `${viewport.name} Overview`)
  if ((await evaluate(`document.documentElement.dataset.theme`)) !== 'light') await evaluate(`document.querySelector('.theme-toggle')?.click()`)
  await waitFor(`document.documentElement.dataset.theme === 'light'`, `${viewport.name} light theme`)
  report.viewports[viewport.name] = await evaluate(`({
    width: innerWidth,
    pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    fleetSnapshot: Boolean(document.querySelector('#fleet-snapshot-title')),
    topRunning: document.querySelectorAll('#top-running-title + .overview-rank-card, .overview-rank-panel:first-child .overview-rank-card').length,
    attention: document.querySelectorAll('.overview-rank-panel:nth-child(2) .overview-rank-card').length,
    allocationRows: document.querySelectorAll('.overview-allocation-row').length,
    radiusStates: document.querySelectorAll('.overview-hierarchy-states .overview-state-card').length,
    operationsRawToggle: Boolean(document.querySelector('.overview-mode-toggle')),
    hierarchy: document.body.textContent.includes('Radius state') && document.body.textContent.includes('Process group') && document.body.textContent.includes('Process family'),
    activityFocus: document.body.textContent.includes('Activity Focus'),
    tablesContained: [...document.querySelectorAll('.overview-table-scroll')].every((item) => item.scrollWidth >= item.clientWidth),
    theme: document.documentElement.dataset.theme,
  })`)
  await capture(`${viewport.name}-light`)
}

await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
await navigate(applicationUrl, `Boolean(document.querySelector('.overview-snapshot'))`, 'desktop Overview interaction')
if ((await evaluate(`document.documentElement.dataset.theme`)) !== 'dark') await evaluate(`document.querySelector('.theme-toggle')?.click()`)
await waitFor(`document.documentElement.dataset.theme === 'dark'`, 'dark theme')
report.dark = await evaluate(`({ theme: document.documentElement.dataset.theme, pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, snapshotBackground: getComputedStyle(document.querySelector('.overview-snapshot')).backgroundColor })`)
await capture('desktop-1440-dark')

await evaluate(`document.querySelector('.overview-state-card--bad')?.click()`)
await waitFor(`document.querySelector('.overview-state-card--bad')?.classList.contains('active') && document.querySelectorAll('.overview-group-list button').length > 0 && document.querySelectorAll('.overview-family-list button').length > 0`, 'fleet Bad hierarchy')
await evaluate(`document.querySelector('.overview-stack-segment--bad')?.click()`)
await waitFor(`Boolean(document.querySelector('.overview-allocation-detail'))`, 'fleet allocation semantic detail')
report.fleetHierarchy = await evaluate(`({
  toggleRemoved: !document.querySelector('.overview-mode-toggle'),
  selectedState: document.querySelector('.overview-state-card.active span')?.textContent,
  groups: document.querySelectorAll('.overview-group-list button').length,
  families: document.querySelectorAll('.overview-family-list button').length,
  exactTableRemoved: !document.querySelector('.overview-exact-table'),
  allocationDetail: document.querySelector('.overview-allocation-detail')?.textContent,
  pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
})`)

await evaluate(`document.querySelector('.press-scope-button[data-press-key="press5"]')?.click()`)
await waitFor(`new URLSearchParams(location.search).get('press') === 'press5' && Boolean(document.querySelector('#press-summary-title'))`, 'single-press Overview')
await evaluate(`document.querySelector('.overview-gantt-segment--process:not(.overview-gantt-segment--offline)')?.focus()`)
await waitFor(`document.querySelectorAll('.overview-gantt-segment.linked').length >= 2`, 'linked Gantt focus')
await evaluate(`document.querySelector('.overview-gantt-segment--process:not(.overview-gantt-segment--offline)')?.click()`)
await waitFor(`Boolean(document.querySelector('.overview-selected-period'))`, 'selected Gantt period')
report.singlePress = await evaluate(`({
  title: document.querySelector('#press-summary-title')?.textContent,
  fleetRank: document.querySelector('.overview-position dd')?.textContent,
  radiusSegments: document.querySelectorAll('.overview-gantt-segment--radius').length,
  processSegments: document.querySelectorAll('.overview-gantt-segment--process').length,
  unavailableSegments: document.querySelectorAll('.overview-gantt-segment--offline').length,
  linkedSegments: document.querySelectorAll('.overview-gantt-segment.linked').length,
  selectedPeriod: document.querySelector('.overview-selected-period')?.textContent,
  tracksShareWidth: (() => { const tracks = [...document.querySelectorAll('.overview-gantt-track')]; return tracks.length === 2 && Math.abs(tracks[0].getBoundingClientRect().width - tracks[1].getBoundingClientRect().width) < 1 })(),
  modeToggleRemoved: !document.querySelector('.overview-mode-toggle'),
  activityFocus: document.body.textContent.includes('Activity Focus'),
  pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
})`)
await capture('single-press-synchronized-dark')

for (const [path, selector, key] of [
  ['/operational-analysis', '.operational-analysis-page', 'operationalAnalysis'],
  ['/patterns-episodes', '.patterns-episodes-page', 'patternsEpisodes'],
  ['/intelligent-search', '.intelligent-search-page', 'intelligentSearch'],
  ['/administration/state-classification', '.classification-page', 'classification'],
]) {
  const url = new URL(path, applicationUrl).toString()
  await navigate(url, `Boolean(document.querySelector(${JSON.stringify(selector)}))`, key)
  report.regressions[key] = await evaluate(`({ path: location.pathname, title: document.querySelector('.page-introduction h1, h1')?.textContent, serverError: Boolean(document.querySelector('.unavailable-panel')) })`)
}

report.analyticsResponsive = {}
for (const viewport of [
  { name: 'desktop-1600', width: 1600, height: 1050 },
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'desktop-1200', width: 1200, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  await command('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.width < 600 })
  await navigate(new URL('/operational-analysis', applicationUrl).toString(), `Boolean(document.querySelector('.activity-header .activity-metrics'))`, `${viewport.name} Operational Analysis`)
  if ((await evaluate(`document.documentElement.dataset.theme`)) !== 'light') await evaluate(`document.querySelector('.theme-toggle')?.click()`)
  await waitFor(`document.documentElement.dataset.theme === 'light'`, `${viewport.name} analytics light theme`)
  const operational = await evaluate(`({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    metrics: document.querySelectorAll('.activity-metrics dd').length,
    pressBars: document.querySelectorAll('.analysis-bars button').length,
    trend: Boolean(document.querySelector('.activity-trend')),
    distribution: Boolean(document.body.textContent.includes('Duration distribution')),
    evidenceRows: document.querySelectorAll('.activity-evidence tbody tr').length,
    evidenceContained: [...document.querySelectorAll('.analysis-table-scroll')].every((item) => item.scrollWidth >= item.clientWidth),
  })`)
  await navigate(new URL('/patterns-episodes', applicationUrl).toString(), `Boolean(document.querySelector('.pattern-summary'))`, `${viewport.name} Patterns`)
  const patterns = await evaluate(`({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    summary: document.querySelectorAll('.pattern-summary dd').length,
    prevalenceRows: document.querySelectorAll('.pattern-bars button').length,
    tabs: document.querySelectorAll('.analysis-tabs [role=tab]').length,
    evidenceContained: [...document.querySelectorAll('.analysis-table-scroll')].every((item) => item.scrollWidth >= item.clientWidth),
  })`)
  report.analyticsResponsive[viewport.name] = { operational, patterns, theme: await evaluate(`document.documentElement.dataset.theme`) }
}

await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
await navigate(new URL('/operational-analysis', applicationUrl).toString(), `Boolean(document.querySelector('.activity-header .activity-metrics'))`, 'Operational activity interaction')
await evaluate(`(() => { const input = document.querySelector('.activity-picker input'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, 'Cleaning / Wash'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
await waitFor(`Boolean([...document.querySelectorAll('#activity-results button')].find((item) => item.textContent.includes('Cleaning / Wash')))`, 'Cleaning activity result')
await evaluate(`[...document.querySelectorAll('#activity-results button')].find((item) => item.textContent.includes('Cleaning / Wash'))?.click()`)
await waitFor(`document.querySelector('.activity-header h2')?.textContent === 'Cleaning / Wash'`, 'Cleaning activity analysis')
report.operationalInteraction = await evaluate(`({ selection: document.querySelector('.activity-header h2')?.textContent, metrics: document.querySelector('.activity-metrics')?.textContent, evidenceRows: document.querySelectorAll('.activity-evidence tbody tr').length, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth })`)

await navigate(new URL('/patterns-episodes', applicationUrl).toString(), `Boolean(document.querySelector('.pattern-summary'))`, 'Matched Run detail reuse')
await evaluate(`document.querySelector('.pattern-bars button')?.click()`)
await waitFor(`Boolean(document.querySelector('.pattern-explorer .analysis-table-scroll tbody tr'))`, 'matched Run evidence')
const matchedEvidence = await evaluate(`(() => { const row = document.querySelector('.pattern-explorer .analysis-table-scroll tbody tr'); return { press: row?.querySelector('th')?.textContent, start: row?.querySelector('td')?.textContent } })()`)
await evaluate(`document.querySelector('.pattern-explorer .analysis-table-scroll tbody tr')?.click()`)
await waitFor(`Boolean(document.querySelector('#pattern-run-detail .selected-run-heading')) && !document.querySelector('.scope-progress')`, 'existing Run detail')
report.matchedRunDetail = { ...matchedEvidence, ...await evaluate(`({ heading: document.querySelector('#pattern-run-detail .selected-run-heading')?.textContent, selectedRow: document.querySelector('#pattern-run-detail .run-row.selected .run-row-summary small')?.textContent, press: new URLSearchParams(location.search).get('press') })`) }

await navigate(new URL('/patterns-episodes', applicationUrl).toString(), `Boolean(document.querySelector('.pattern-summary'))`, 'Pattern Builder interaction')
await evaluate(`[...document.querySelectorAll('.analysis-tabs button')].find((item) => item.textContent.includes('Pattern Builder'))?.click()`)
await waitFor(`Boolean(document.querySelector('.pattern-builder-panel'))`, 'Pattern Builder tab')
for (const activity of ['Maintenance Intervention', 'Cleaning / Wash']) {
  await evaluate(`(() => { const input = document.querySelector('.activity-picker input'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(activity)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await waitFor(`Boolean([...document.querySelectorAll('#activity-results button')].find((item) => item.textContent.includes(${JSON.stringify(activity)})))`, `${activity} builder result`)
  await evaluate(`[...document.querySelectorAll('#activity-results button')].find((item) => item.textContent.includes(${JSON.stringify(activity)}))?.click()`)
}
await evaluate(`[...document.querySelectorAll('.builder-mode button')].find((item) => item.textContent.includes('Analyze Runs'))?.click()`)
await waitFor(`Boolean(document.querySelector('.matched-donut')) && !document.querySelector('.scope-progress')`, 'Contains All result')
const containsAll = await evaluate(`({ title: document.querySelector('.pattern-builder-panel + .panel h2, .message + .panel h2')?.textContent, result: document.querySelector('.matched-donut')?.parentElement?.textContent, evidenceRows: document.querySelectorAll('.pattern-explorer .analysis-table-scroll tbody tr').length })`)
await evaluate(`[...document.querySelectorAll('.builder-mode button')].find((item) => item.textContent.includes('In This Order'))?.click()`)
await evaluate(`[...document.querySelectorAll('.builder-mode button')].find((item) => item.textContent.includes('Analyze Runs'))?.click()`)
await waitFor(`Boolean([...document.querySelectorAll('.pattern-explorer h2')].find((item) => item.textContent === 'In This Order')) && !document.querySelector('.scope-progress')`, 'In This Order result')
report.patternBuilderInteraction = { containsAll, inOrder: await evaluate(`({ title: [...document.querySelectorAll('.pattern-explorer h2')].find((item) => item.textContent === 'In This Order')?.textContent, result: document.querySelector('.matched-donut')?.parentElement?.textContent, evidenceRows: document.querySelectorAll('.pattern-explorer .analysis-table-scroll tbody tr').length, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth })`) }

if ((await evaluate(`document.documentElement.dataset.theme`)) !== 'dark') await evaluate(`document.querySelector('.theme-toggle')?.click()`)
await waitFor(`document.documentElement.dataset.theme === 'dark'`, 'analytics dark theme')
await delay(250)
report.analyticsDark = await evaluate(`({ theme: document.documentElement.dataset.theme, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, panel: getComputedStyle(document.querySelector('.panel')).backgroundColor, text: getComputedStyle(document.querySelector('.panel')).color })`)
await capture('patterns-builder-dark')

socket.close()
console.log(JSON.stringify(report, null, 2))
