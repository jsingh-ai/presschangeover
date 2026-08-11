import { writeFile } from 'node:fs/promises'

const debuggerUrl = process.argv[2] ?? 'http://127.0.0.1:9222'
const applicationUrl = process.argv[3] ?? 'http://10.8.10.97:8088/overview'
const outputSection = process.argv[5] ?? (process.argv[4] === 'interrupted-episode' ? process.argv[4] : undefined)
const screenshotPath = process.argv[4] === 'interrupted-episode' ? undefined : process.argv[4]

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
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
    throw new Error(`${detail}; expression: ${expression.slice(0, 180)}`)
  }
  return result.result.value
}

async function waitFor(expression, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if (await evaluate(expression)) return
    } catch {}
    await delay(250)
  }
  const debug = await evaluate(`({ url: location.href, title: document.querySelector('h1')?.textContent, active: document.querySelector('.primary-nav-link.active')?.textContent, loading: document.querySelector('[role=status]')?.textContent, error: document.querySelector('.unavailable-panel')?.textContent, drawer: Boolean(document.querySelector('.investigation-side-panel')), close: Boolean(document.querySelector('.drawer-close')), blocks: [...document.querySelectorAll('.drawer-state-block')].map((item) => ({ text: item.textContent.trim(), disabled: item.disabled })) })`)
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(debug)}`)
}

async function clickByText(selector, text) {
  return evaluate(`(() => { const item = [...document.querySelectorAll(${JSON.stringify(selector)})].find((candidate) => candidate.textContent.includes(${JSON.stringify(text)})); if (!item) return false; item.click(); return true })()`)
}

async function capture(path) {
  const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(path, Buffer.from(screenshot.data, 'base64'))
}

await command('Page.enable')
await command('Runtime.enable')
await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
await command('Page.navigate', { url: applicationUrl })
await waitFor(`document.readyState === 'complete' && Boolean(document.querySelector('.overview-page')) && document.querySelectorAll('.operational-panel .timeline-row').length === 12`, 'Overview fleet workspace')

const report = {
  overview: await evaluate(`({
    path: location.pathname,
    navItems: document.querySelectorAll('.primary-nav-link').length,
    activeNav: document.querySelector('.primary-nav-link.active strong')?.textContent,
    title: document.querySelector('.page-introduction h1')?.textContent,
    fleetRows: document.querySelectorAll('.operational-panel .timeline-row').length,
    signalMetrics: document.querySelectorAll('.signal-metric').length,
    priorities: document.querySelectorAll('.priority-item').length,
    pressScope: document.querySelector('.press-scope-button.active')?.dataset.pressKey,
    theme: document.documentElement.dataset.theme,
    filterGroups: document.querySelectorAll('.filter-group').length,
    pressButtons: document.querySelectorAll('.press-scope-button').length,
    dataHealth: document.querySelector('.data-health')?.textContent.trim(),
    contentLeftGap: Math.round(document.querySelector('.workspace-content').getBoundingClientRect().left - document.querySelector('.app-sidebar').getBoundingClientRect().right),
    contentRightGap: Math.round(innerWidth - document.querySelector('.workspace-content').getBoundingClientRect().right),
  })`),
}

await evaluate(`document.querySelector('[aria-label="Zoom in timeline"]').click()`)
await waitFor(`document.querySelector('[aria-label="Timeline zoom level"]')?.textContent.includes('150%') && document.querySelector('.timeline-scroll').scrollWidth > document.querySelector('.timeline-scroll').clientWidth`, 'timeline zoom and overflow')
await evaluate(`document.querySelector('.timeline-scroll').scrollLeft = document.querySelector('.timeline-scroll').scrollWidth`)
report.timelineInteraction = await evaluate(`({ zoom: document.querySelector('[aria-label="Timeline zoom level"]')?.textContent.trim(), containedScroll: document.querySelector('.timeline-scroll').scrollWidth > document.querySelector('.timeline-scroll').clientWidth && document.querySelector('.timeline-scroll').scrollLeft > 0, documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, rowCursor: getComputedStyle(document.querySelector('.timeline-row--interactive')).cursor, rowTooltip: document.querySelector('.timeline-row--interactive')?.title, segmentTooltip: document.querySelector('.timeline-segment')?.title, controls: document.querySelectorAll('.timeline-zoom-controls button').length })`)
const firstSegmentRect = await evaluate(`(() => { const rect = document.querySelector('.timeline-segment')?.getBoundingClientRect(); return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : undefined })()`)
await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: firstSegmentRect.x, y: firstSegmentRect.y })
await evaluate(`document.querySelector('.timeline-segment')?.focus()`)
await waitFor(`Boolean(document.querySelector('.timeline-hover-tooltip'))`, 'overview segment hover tooltip')
report.overviewSegmentHover = await evaluate(`({ pressFilter: document.querySelector('.press-scope-button.active')?.dataset.pressKey || '', queryPress: new URLSearchParams(location.search).get('press'), fleetRows: document.querySelectorAll('.operational-panel .timeline-row').length, tooltip: document.querySelector('.timeline-hover-tooltip')?.textContent.trim(), drawer: Boolean(document.querySelector('.investigation-side-panel')) })`)
await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 8, y: 8 })
await evaluate(`document.querySelector('.timeline-segment')?.blur()`)
await waitFor(`!document.querySelector('.timeline-hover-tooltip')`, 'overview segment hover tooltip close')
if (screenshotPath) {
  await evaluate(`document.querySelector('.operational-panel').scrollIntoView({ block: 'start' })`)
  await delay(200)
  await capture(screenshotPath.replace(/\.png$/i, '-timeline-zoom-light.png'))
}
await evaluate(`document.querySelector('.timeline-reset').click()`)
await waitFor(`document.querySelector('[aria-label="Timeline zoom level"]')?.textContent.includes('100%') && document.querySelector('.timeline-scroll').scrollLeft === 0`, 'timeline zoom reset')
await evaluate(`window.scrollTo({ top: 0 })`)
await evaluate(`document.querySelector('.timeline-label-button').click()`)
await waitFor(`Boolean(document.querySelector('.overview-page .selected-workspace')) && Boolean(document.querySelector('.press-activity-focus-control .selected-press-chip')) && !document.querySelector('.analytics-loading')`, 'inline timeline press investigation')
report.timelineSelection = await evaluate(`({ workspaceVisible: Boolean(document.querySelector('.overview-page')), blockingLoader: Boolean(document.querySelector('.analytics-loading')), visibleRows: document.querySelectorAll('.operational-panel .timeline-row').length, pressChip: document.querySelector('.press-activity-focus-control .selected-press-chip')?.textContent.trim(), chipAboveActivity: Boolean(document.querySelector('.operational-panel > .press-activity-focus-control .selected-press-chip')), workspaceHasDuplicateChip: Boolean(document.querySelector('.selected-workspace .selected-press-chip')), fullProductionBars: document.querySelectorAll('.comparison-phase--return-confirmed').length, completeRangeSegments: document.querySelectorAll('.focused-range-segment').length, rangeStart: document.querySelector('.focused-range-axis time:first-child')?.textContent.trim(), rangeEnd: document.querySelector('.focused-range-axis time:last-child')?.textContent.trim(), hasPrevious: !document.querySelector('[aria-label="Previous press"]')?.disabled, hasNext: !document.querySelector('[aria-label="Next press"]')?.disabled, backToOverview: document.querySelector('.back-to-overview')?.textContent.trim(), globalPressChanged: location.search.includes('press=') })`)
report.timelineSelection.runSnapshot = await evaluate(`({ visible: Boolean(document.querySelector('.overview-page .focused-run-snapshot')), metrics: document.querySelectorAll('.overview-page .focused-run-snapshot dl > div').length, rows: document.querySelectorAll('.overview-page .run-row').length, text: document.querySelector('.overview-page .focused-run-snapshot')?.textContent.trim() })`)
if (screenshotPath) {
  await evaluate(`document.querySelector('.overview-page .selected-workspace').scrollIntoView({ block: 'start' })`)
  await delay(200)
  await capture(screenshotPath.replace(/\.png$/i, '-inline-focus-light.png'))
}
const focusScrollBefore = await evaluate(`(() => { const workspace = document.querySelector('.overview-page .selected-workspace'); window.__cycleWorkspace = workspace; window.scrollTo({ top: workspace.offsetTop + 260 }); return window.scrollY })()`)
await evaluate(`document.querySelector('[aria-label="Next press"]').click()`)
await waitFor(`document.querySelector('.press-activity-focus-control .selected-press-chip')?.textContent.includes('Press 5') && document.querySelector('.selected-workspace .selected-press-bar h2')?.textContent.includes('Press 5') && document.querySelectorAll('.operational-panel .timeline-row').length === 1`, 'next focused press')
report.timelineSelection.nextPress = await evaluate(`document.querySelector('.press-activity-focus-control .selected-press-chip')?.textContent.trim()`)
report.timelineSelection.cyclePreservedWorkspace = await evaluate(`window.__cycleWorkspace === document.querySelector('.overview-page .selected-workspace') && window.__cycleWorkspace.isConnected`)
report.timelineSelection.cycleScrollDelta = Math.abs((await evaluate(`window.scrollY`)) - focusScrollBefore)
await evaluate(`document.querySelector('.back-to-overview').click()`)
await waitFor(`!document.querySelector('.overview-page .selected-workspace') && Boolean(document.querySelector('.focused-investigation-empty'))`, 'back to overview')

await clickByText('.range-button', 'Custom')
await waitFor(`Boolean(document.querySelector('#custom-range-controls'))`, 'custom time controls')
report.customRange = await evaluate(`(() => { const presets = document.querySelector('.range-presets')?.getBoundingClientRect(); const custom = document.querySelector('#custom-range-controls')?.getBoundingClientRect(); const button = document.querySelector('#custom-range-controls .custom-apply-button')?.getBoundingClientRect(); return { fields: document.querySelectorAll('#custom-range-controls input[type="datetime-local"]').length, applyButton: document.querySelector('#custom-range-controls .custom-apply-button')?.textContent.trim(), horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, besidePresets: Boolean(presets && custom && custom.left >= presets.right - 2), controlHeightMatch: Boolean(custom && button && Math.abs(custom.height - button.height) < 12) } })()`)
await clickByText('.range-button', 'Custom')
await waitFor(`!document.querySelector('#custom-range-controls')`, 'custom time controls close')
const realDataTo = new Date()
const realDataFrom = new Date(realDataTo.getTime() - 3 * 24 * 60 * 60 * 1_000)
const realDataUrl = new URL('/operational-analysis', applicationUrl)
realDataUrl.search = new URLSearchParams({ fromUtc: realDataFrom.toISOString(), toUtc: realDataTo.toISOString(), preset: 'custom' }).toString()
await command('Page.navigate', { url: realDataUrl.toString() })
await waitFor(`location.pathname === '/operational-analysis' && document.querySelector('.range-button.active')?.textContent.includes('Custom') && Boolean(document.querySelector('.operational-analysis-page'))`, 'three-day Operational Analysis route')
report.operationalPressHistoryAllPresses = await evaluate(`({ instruction: document.querySelector('.run-empty-state h3')?.textContent.trim(), rows: document.querySelectorAll('.run-row').length, selectedRunAnalysis: Boolean(document.querySelector('.selected-run-analysis')), localPressButtons: document.querySelectorAll('.run-press-selector .press-scope-button').length, localAllActive: document.querySelector('.run-press-selector .press-scope-button[data-press-key=""]')?.classList.contains('active') })`)
await evaluate(`document.querySelector('.run-press-selector .press-scope-button[data-press-key="press13"]').click()`)
await waitFor(`location.search.includes('press=press13') && Boolean(document.querySelector('.press-state-history'))`, 'Press 13 history')

report.operationalState = await evaluate(`({
  activeNav: document.querySelector('.primary-nav-link.active strong')?.textContent,
  stateBreakdown: Boolean(document.querySelector('.state-breakdown')),
  pressStateTimeline: Boolean(document.querySelector('.press-state-history')),
  pressSelector: document.querySelector('.press-state-history select')?.value,
  chronologicalSegments: document.querySelectorAll('.press-state-segment').length,
  detailRows: document.querySelectorAll('.press-state-event-list tbody tr').length,
  runThreshold: document.querySelector('.press-state-context > div:last-child strong')?.textContent,
  statusDrivers: Boolean(document.querySelector('.status-drivers')),
  stopsRecovery: Boolean(document.querySelector('.patterns-panel')),
  tabs: [...document.querySelectorAll('.analysis-tabs [role="tab"]')].map((tab) => ({ label: tab.textContent.trim(), selected: tab.getAttribute('aria-selected') })),
  range: document.querySelector('.range-button.active')?.textContent.trim(),
  pressScope: document.querySelector('.press-scope-button.active')?.dataset.pressKey,
})`)

report.operationalPressHistory = await evaluate(`({ heading: document.querySelector('.run-comparison > .section-heading h2')?.textContent.trim(), rows: document.querySelectorAll('.run-row').length, selectedRunAnalysis: Boolean(document.querySelector('.selected-run-analysis')), contributors: Boolean(document.querySelector('.run-contributors')), exactStatusBenchmarks: Boolean(document.querySelector('.run-status-benchmark')), localPressActive: document.querySelector('.run-press-selector .press-scope-button.active')?.dataset.pressKey, globalPressActive: document.querySelector('.context-header .press-scope-button.active')?.dataset.pressKey, timeline: Boolean(document.querySelector('.press-state-history')), pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth })`)

await waitFor(`document.querySelectorAll('.press-state-segment').length > 0`, 'Press State Timeline spans')
await evaluate(`document.querySelector('.press-state-history').scrollIntoView({ block: 'start' }); document.querySelector('.press-state-segment').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`)
await waitFor(`Boolean(document.querySelector('.timeline-hover-tooltip'))`, 'Press State Timeline tooltip')
report.pressStateInteraction = await evaluate(`({ tooltip: document.querySelector('.timeline-hover-tooltip')?.textContent.trim(), documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, containedOverflow: document.querySelector('.press-state-timeline-scroll').scrollWidth >= document.querySelector('.press-state-timeline-scroll').clientWidth })`)
await evaluate(`document.querySelector('.press-state-segment').click(); document.querySelector('.press-state-segment').dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))`)
await waitFor(`Boolean(document.querySelector('.press-state-selection')) && !document.querySelector('.timeline-hover-tooltip')`, 'Press State Timeline interval selection')
report.pressStateInteraction.selected = await evaluate(`document.querySelector('.press-state-selection')?.textContent.trim()`)
if (screenshotPath) {
  await evaluate(`document.querySelector('.press-state-history').scrollIntoView({ block: 'start' })`)
  await delay(200)
  await capture(screenshotPath.replace(/\.png$/i, '-state-timeline-light.png'))
}
await waitFor(`Boolean(document.querySelector('.press-state-segment--run-short'))`, 'live short Run Production attempt')
await evaluate(`document.querySelector('.press-state-segment--run-short').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`)
await waitFor(`Boolean(document.querySelector('.timeline-hover-tooltip'))`, 'short Run Production tooltip')
report.shortRunAttempt = await evaluate(`({ press: document.querySelector('.press-state-context strong')?.textContent.trim(), tooltip: document.querySelector('.timeline-hover-tooltip')?.textContent.trim(), ariaLabel: document.querySelector('.press-state-segment--run-short')?.getAttribute('aria-label') })`)
if (screenshotPath) await capture(screenshotPath.replace(/\.png$/i, '-short-run-light.png'))
await evaluate(`document.querySelector('.press-state-segment--run-short').dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))`)

await clickByText('.primary-nav-link', 'Patterns & Episodes')
await waitFor(`Boolean(document.querySelector('.patterns-episodes-page .comparison-board')) && document.querySelectorAll('.comparison-phase--offline').length > 0`, 'Press 13 interrupted Episode Gantt')
report.interruptedEpisodeGantt = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.comparison-row')]
  const row = rows.find((candidate) => candidate.querySelector('.comparison-phase--offline'))
  const index = rows.indexOf(row)
  const label = row?.querySelector('.comparison-row-label')
  const sequence = row?.querySelector('.comparison-phase-sequence')
  const offline = row?.querySelector('.comparison-phase--offline')
  const rangeOffline = [...document.querySelectorAll('.focused-range-segment--offline')].find((candidate) => offline?.title.includes(candidate.title.split('\\n').find((line) => line.startsWith('Start:')) ?? '__missing__'))
  return { rows: rows.length, offlineEpisodeSegments: document.querySelectorAll('.comparison-phase--offline').length, timing: label?.textContent.trim(), timingHasPhaseName: /Make Ready|Non Productive|Plates: Wash|Press Problem/.test(label?.textContent ?? ''), sequence: sequence?.textContent.trim(), sequenceEndsUnavailable: sequence?.textContent.trim().endsWith('Data unavailable'), hasPostGapRows: index >= 0 && index < rows.length - 1, tooltip: offline?.title, canonicalOfflineMatch: Boolean(rangeOffline), horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }
})()`)
await clickByText('.primary-nav-link', 'Operational Analysis')
await waitFor(`Boolean(document.querySelector('.press-state-history')) && document.querySelector('.context-summary small')?.textContent.includes('Press 13')`, 'return to Press 13 Operational Analysis')

await clickByText('.analysis-tabs [role="tab"]', 'Drivers & recovery')
await waitFor(`Boolean(document.querySelector('.status-drivers')) && Boolean(document.querySelector('.patterns-panel')) && !document.querySelector('.press-state-history')`, 'combined Drivers and Recovery tab')
report.driversRecoveryTab = await evaluate(`({ selectedTab: document.querySelector('.analysis-tabs [aria-selected="true"]')?.textContent.trim(), statusDrivers: Boolean(document.querySelector('.status-drivers')), stopsRecovery: Boolean(document.querySelector('.patterns-panel')), stateBreakdown: Boolean(document.querySelector('.state-breakdown')), pressStateTimeline: Boolean(document.querySelector('.press-state-history')), querySection: new URLSearchParams(location.search).get('section') })`)
report.statusDrivers = await evaluate(`({ groups: document.querySelectorAll('.driver-group').length, rows: document.querySelectorAll('.driver-list button').length, exactIdentity: document.querySelector('.driver-list strong')?.textContent })`)
if (screenshotPath) {
  await evaluate(`window.scrollTo({ top: 0, left: 0 })`)
  await delay(200)
  await capture(screenshotPath.replace(/\.png$/i, '-operational-light.png'))
}

await evaluate(`document.querySelector('.driver-list button').click()`)
await waitFor(`document.querySelector('.drawer-header .eyebrow')?.textContent.includes('status')`, 'status evidence drawer')
report.statusDrawer = await evaluate(`({ focusInside: document.querySelector('.investigation-side-panel').contains(document.activeElement), intervals: document.querySelectorAll('.drawer-evidence-list li').length, contextRelationships: document.querySelectorAll('.drawer-cohort-grid > div').length, workspaceMounted: Boolean(document.querySelector('.operational-analysis-page')), urlHasStatus: location.search.includes('status=') })`)
await evaluate(`document.querySelector('.drawer-close').click()`)
await waitFor(`!document.querySelector('.investigation-side-panel') && Boolean(document.querySelector('.status-drivers'))`, 'status drawer close')

await evaluate(`document.querySelector('.press-scope-button[data-press-key="press7"]').click()`)
await waitFor(`location.search.includes('press=press7') && document.querySelector('.context-summary small')?.textContent.includes('Press 7') && Boolean(document.querySelector('.status-drivers'))`, 'Press 7 preserved Operational Analysis')
await clickByText('.primary-nav-link', 'Patterns & Episodes')
await waitFor(`location.pathname === '/patterns-episodes' && Boolean(document.querySelector('.patterns-episodes-page')) && Boolean(document.querySelector('.selected-workspace'))`, 'Press 7 Patterns and Episodes')

await evaluate(`[...document.querySelectorAll('.relationship-evidence-grid details')].forEach((item) => { item.open = true })`)
report.patterns = await evaluate(`({
  activeNav: document.querySelector('.primary-nav-link.active strong')?.textContent,
  press: new URLSearchParams(location.search).get('press'),
  range: document.querySelector('.range-button.active')?.textContent.trim(),
  relationship: Boolean(document.querySelector('.relationship-panel')),
  exactSupport: document.querySelector('.relationship-result strong')?.textContent.trim(),
  matchingEvidence: document.querySelectorAll('.relationship-evidence-grid details:first-child li').length,
  variationEvidence: document.querySelectorAll('.relationship-evidence-grid details:last-child li').length,
  deviations: document.querySelectorAll('.anomaly-list button').length,
  episodeBoard: Boolean(document.querySelector('.comparison-board')),
  attentionItems: document.querySelectorAll('.attention-list button').length,
  completeRangeSegments: document.querySelectorAll('.focused-range-segment').length,
  offlineRangeSegments: document.querySelectorAll('.focused-range-segment--offline').length,
  hasActivityAfterOffline: (() => { const segments = [...document.querySelectorAll('.focused-range-segment')]; const offline = segments.findIndex((item) => item.classList.contains('focused-range-segment--offline')); return offline >= 0 && segments.slice(offline + 1).some((item) => !item.classList.contains('focused-range-segment--offline')) })(),
})`)
if (screenshotPath) await capture(screenshotPath.replace(/\.png$/i, '-patterns-light.png'))

const attentionExists = await evaluate(`Boolean(document.querySelector('.attention-list button'))`)
if (attentionExists) {
  await evaluate(`window.__attentionWorkspace = document.querySelector('.selected-workspace'); document.querySelector('.attention-list button').click()`)
  await waitFor(`document.querySelector('.drawer-header .eyebrow')?.textContent.includes('attention')`, 'attention evidence drawer')
  report.attentionEvidence = await evaluate(`({ sections: [...document.querySelectorAll('.exception-evidence-card h3')].map((item) => item.textContent.trim()), facts: document.querySelectorAll('.exception-facts > div').length, reasons: document.querySelectorAll('.finding-reasons li').length, hasFullProduction: document.querySelector('.exception-evidence-card')?.parentElement?.textContent.includes('Full production observed after recovery') })`)
  await evaluate(`document.querySelector('.drawer-close').click()`)
  await waitFor(`!document.querySelector('.investigation-side-panel') && Boolean(document.querySelector('.selected-workspace')) && !document.querySelector('.analytics-loading')`, 'attention drawer close without workspace reload')
  report.attentionEvidence.closeKeptWorkspace = await evaluate(`window.__attentionWorkspace === document.querySelector('.selected-workspace') && window.__attentionWorkspace.isConnected`)
}

const phaseExists = await evaluate(`Boolean(document.querySelector('.comparison-phase--make-ready'))`)
if (phaseExists) {
  const scrollBefore = await evaluate(`window.scrollY`)
  await evaluate(`document.querySelector('.comparison-phase--make-ready').click()`)
  await waitFor(`document.querySelector('.drawer-header .eyebrow')?.textContent.includes('segment')`, 'episode segment drawer')
  report.segmentDrawer = await evaluate(`({ workspaceMounted: Boolean(document.querySelector('.selected-workspace')), focusInside: document.querySelector('.investigation-side-panel').contains(document.activeElement), urlHasSegment: location.search.includes('segmentStart=') })`)
  await evaluate(`document.querySelector('.drawer-close').click()`)
  await waitFor(`!document.querySelector('.investigation-side-panel')`, 'episode segment drawer close')
  report.segmentDrawer.scrollDelta = Math.abs((await evaluate(`window.scrollY`)) - scrollBefore)
}

await evaluate(`history.back()`)
await waitFor(`location.pathname === '/operational-analysis' && location.search.includes('press=press7') && Boolean(document.querySelector('.status-drivers'))`, 'Back restores Operational Analysis context')
report.backNavigation = await evaluate(`({ path: location.pathname, press: new URLSearchParams(location.search).get('press'), activeNav: document.querySelector('.primary-nav-link.active strong')?.textContent })`)

await clickByText('.primary-nav-link', 'Overview')
await waitFor(`location.pathname === '/overview' && document.querySelectorAll('.operational-panel .timeline-row').length === 1`, 'Press 7 Overview')
await evaluate(`document.querySelector('.press-scope-button[data-press-key=""]').click()`)
await waitFor(`!location.search.includes('press=') && document.querySelectorAll('.operational-panel .timeline-row').length === 12`, 'clear press restores fleet')

await evaluate(`document.documentElement.dataset.theme === 'dark' || document.querySelector('.theme-toggle').click()`)
await waitFor(`document.documentElement.dataset.theme === 'dark' && localStorage.getItem('process-intelligence-theme') === 'dark'`, 'dark theme')
await delay(250)
report.darkTheme = await evaluate(`({ theme: document.documentElement.dataset.theme, persisted: localStorage.getItem('process-intelligence-theme'), bodyBackground: getComputedStyle(document.body).backgroundColor, panelBackground: getComputedStyle(document.querySelector('.panel')).backgroundColor, textColor: getComputedStyle(document.querySelector('.page-introduction h1')).color })`)

await command('Page.reload', { ignoreCache: false })
await waitFor(`document.documentElement.dataset.theme === 'dark' && Boolean(document.querySelector('.overview-page'))`, 'persisted dark theme reload')
report.darkTheme.persistedAfterReload = await evaluate(`localStorage.getItem('process-intelligence-theme') === 'dark'`)

report.responsive = {}
for (const viewport of [{ name: 'desktop-dark', width: 1600, height: 1000, mobile: false }, { name: 'desktop-compact-dark', width: 1440, height: 900, mobile: false }, { name: 'tablet-dark', width: 1100, height: 850, mobile: false }, { name: 'compact-dark', width: 768, height: 900, mobile: false }, { name: 'mobile-dark', width: 390, height: 844, mobile: true }]) {
  await command('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile })
  await delay(300)
  report.responsive[viewport.name] = {}
  for (const area of [{ name: 'overview', label: 'Overview', selector: '.overview-page' }, { name: 'operational', label: 'Operational Analysis', selector: '.operational-analysis-page' }, { name: 'patterns', label: 'Patterns & Episodes', selector: '.patterns-episodes-page' }]) {
    await clickByText('.primary-nav-link', area.label)
    await waitFor(`Boolean(document.querySelector(${JSON.stringify(area.selector)}))`, `${viewport.name} ${area.name}`)
    if (area.name === 'operational' && ['desktop-dark', 'mobile-dark'].includes(viewport.name)) {
      await evaluate(`document.querySelector('.run-press-selector .press-scope-button[data-press-key="press13"]')?.click()`)
      await waitFor(`Boolean(document.querySelector('.press-state-history'))`, `${viewport.name} Press 13 history`)
      if (screenshotPath) {
        await evaluate(`document.querySelector('.run-comparison').scrollIntoView({ block: 'start' })`)
        await delay(200)
        await capture(screenshotPath.replace(/\.png$/i, `-press-history-${viewport.name}.png`))
      }
      report.responsive[viewport.name].pressHistory = await evaluate(`({ rows: document.querySelectorAll('.run-row').length, selectedRunAnalysis: Boolean(document.querySelector('.selected-run-analysis')), timeline: Boolean(document.querySelector('.press-state-history')), horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth })`)
    }
    report.responsive[viewport.name][area.name] = await evaluate(`({ width: innerWidth, documentClientWidth: document.documentElement.clientWidth, documentScrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth, navigationVisible: document.querySelectorAll('.primary-nav-link').length === 3, analyticsVisible: Boolean(document.querySelector(${JSON.stringify(area.selector)})), horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, sidebarPosition: getComputedStyle(document.querySelector('.app-sidebar')).position, overflowWidth: document.documentElement.scrollWidth - document.documentElement.clientWidth, timelineGeometry: (() => { const panel = document.querySelector('.press-state-history'); const scroll = document.querySelector('.press-state-timeline-scroll'); return panel && scroll ? { panel: Math.round(panel.getBoundingClientRect().width), panelOverflow: getComputedStyle(panel).overflowX, scroll: Math.round(scroll.getBoundingClientRect().width), scrollClient: scroll.clientWidth, scrollWidth: scroll.scrollWidth, scrollOverflow: getComputedStyle(scroll).overflowX } : null })(), offenders: [...document.querySelectorAll('body *')].map((node) => ({ node, rect: node.getBoundingClientRect() })).filter(({ rect }) => rect.right > innerWidth + 1 || rect.left < -1).slice(0, 5).map(({ node, rect }) => ({ tag: node.tagName, className: node.className?.toString().slice(0, 80), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) })) })`)
    if (screenshotPath && area.name === 'operational' && ['desktop-dark', 'mobile-dark'].includes(viewport.name)) {
      await evaluate(`document.querySelector('.press-state-history').scrollIntoView({ block: 'start' })`)
      await delay(200)
      await capture(screenshotPath.replace(/\.png$/i, `-state-timeline-${viewport.name}.png`))
    }
  }
  await clickByText('.primary-nav-link', 'Overview')
  await waitFor(`Boolean(document.querySelector('.overview-page'))`, `${viewport.name} Overview screenshot`)
  if (screenshotPath) await capture(screenshotPath.replace(/\.png$/i, `-${viewport.name}.png`))
}

await command('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await evaluate(`document.documentElement.dataset.theme === 'light' || document.querySelector('.theme-toggle').click()`)
await waitFor(`document.documentElement.dataset.theme === 'light'`, 'light theme')
await delay(250)
report.lightTheme = await evaluate(`({ theme: document.documentElement.dataset.theme, persisted: localStorage.getItem('process-intelligence-theme'), bodyBackground: getComputedStyle(document.body).backgroundColor, panelBackground: getComputedStyle(document.querySelector('.panel')).backgroundColor, textColor: getComputedStyle(document.querySelector('.page-introduction h1')).color, horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth })`)
if (screenshotPath) await capture(screenshotPath.replace(/\.png$/i, '-desktop-light.png'))
await command('Emulation.clearDeviceMetricsOverride')

socket.close()
process.stdout.write(`${JSON.stringify(outputSection === 'interrupted-episode' ? report.interruptedEpisodeGantt : report, null, 2)}\n`)
