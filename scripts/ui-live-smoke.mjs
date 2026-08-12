import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const debuggerUrl = process.argv[2] ?? 'http://127.0.0.1:9222'
const applicationUrl = process.argv[3] ?? 'http://10.8.10.97:8088/overview'
const screenshotDirectory = process.argv[4]
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function pageTarget() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
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
const consoleErrors = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id) {
    const handler = pending.get(message.id)
    if (!handler) return
    pending.delete(message.id)
    if (message.error) handler.reject(new Error(message.error.message))
    else handler.resolve(message.result)
    return
  }
  if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(message.params.exceptionDetails.text)
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params.args.map(({ value, description }) => value ?? description).join(' '))
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

async function waitFor(expression, label, attempts = 160) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { if (await evaluate(expression)) return } catch {}
    await delay(250)
  }
  const state = await evaluate(`({ path: location.pathname, title: document.querySelector('h1')?.textContent, status: document.querySelector('[role=status]')?.textContent, alert: document.querySelector('[role=alert]')?.textContent })`)
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

async function setTheme(theme) {
  if ((await evaluate('document.documentElement.dataset.theme')) !== theme) await evaluate(`document.querySelector('.theme-toggle')?.click()`)
  await waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`, `${theme} theme`)
}

function routeUrl(path, parameters = {}) {
  const url = new URL(path, applicationUrl)
  Object.entries(parameters).forEach(([key, value]) => url.searchParams.set(key, value))
  return url.toString()
}

await command('Page.enable')
await command('Runtime.enable')
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true })

const routes = [
  { key: 'overview', path: '/overview', ready: `Boolean(document.querySelector('.overview-snapshot'))` },
  { key: 'operational', path: '/operational-analysis', ready: `Boolean(document.querySelector('.activity-header .activity-metrics'))` },
  { key: 'patterns', path: '/patterns-episodes', ready: `Boolean(document.querySelector('.pattern-summary'))` },
  { key: 'search', path: '/intelligent-search', ready: `Boolean(document.querySelector('.intelligent-search-page [role=search]'))` },
  { key: 'admin', path: '/administration/state-classification', ready: `Boolean(document.querySelector('.classification-admin-page'))` },
]
const viewports = [
  { name: '1600', width: 1600, height: 1050 },
  { name: '1440', width: 1440, height: 1000 },
  { name: '1200', width: 1200, height: 900 },
  { name: '768', width: 768, height: 1024 },
  { name: '390', width: 390, height: 844 },
]
const report = { matrix: {}, interactions: {}, telemetry: {}, performance: {}, consoleErrors }
const matrixEnd = new Date(Date.now() - 10 * 60_000)
const matrixStart = new Date(matrixEnd.getTime() - 4 * 60 * 60_000)
const matrixRange = { preset: 'custom', fromUtc: matrixStart.toISOString(), toUtc: matrixEnd.toISOString() }

for (const viewport of viewports) {
  report.matrix[viewport.name] = {}
  await command('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.width < 600 })
  for (const route of routes) {
    await navigate(routeUrl(route.path, matrixRange), route.ready, `${route.key} at ${viewport.name}px`)
    report.matrix[viewport.name][route.key] = {}
    for (const theme of ['light', 'dark']) {
      await setTheme(theme)
      const result = await evaluate(`({
        path: location.pathname,
        title: document.querySelector('.page-introduction h1, .intelligent-search-hero h1, .classification-admin-hero h1, h1')?.textContent,
        theme: document.documentElement.dataset.theme,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        internalOverflowContained: [...document.querySelectorAll('.analysis-table-scroll,.overview-table-scroll,.synchronized-timeline__scroll,.classification-table-scroll')].every((item) => item.getBoundingClientRect().right <= document.documentElement.clientWidth + 1),
        dialogCount: document.querySelectorAll('[role=dialog]').length,
        durationMs: Math.round(performance.getEntriesByType('navigation')[0]?.duration ?? 0),
        resourceBytes: Math.round(performance.getEntriesByType('resource').reduce((sum, item) => sum + (item.transferSize || item.encodedBodySize || 0), 0)),
      })`)
      if (result.overflow) throw new Error(`${route.key} has page-level horizontal overflow at ${viewport.name}px in ${theme} theme`)
      if (result.theme !== theme) throw new Error(`${route.key} did not apply ${theme} theme at ${viewport.name}px`)
      report.matrix[viewport.name][route.key][theme] = result
      await capture(`${viewport.name}-${route.key}-${theme}`)
    }
  }
}

await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
await navigate(routeUrl('/overview', matrixRange), routes[0].ready, 'All Presses Overview')
await setTheme('light')
report.interactions.allPresses = await evaluate(`({ selected: document.querySelector('.press-scope-button[aria-pressed=true]')?.textContent, pressCount: document.querySelectorAll('.press-scope-button[data-press-key]:not([data-press-key=""])').length })`)
await evaluate(`document.querySelector('.press-scope-button[data-press-key="press5"]')?.click()`)
await waitFor(`new URLSearchParams(location.search).get('press') === 'press5' && Boolean(document.querySelector('#press-summary-title'))`, 'individual press')
report.interactions.individualPress = await evaluate(`({ title: document.querySelector('#press-summary-title')?.textContent, timeline: Boolean(document.querySelector('.synchronized-timeline')), overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth })`)

for (const preset of [
  { label: 'Today', value: 'today' },
  { label: 'Last 24 Hours', value: 'last24' },
]) {
  await evaluate(`[...document.querySelectorAll('.range-button')].find((item) => item.textContent.trim() === ${JSON.stringify(preset.label)})?.click()`)
  await waitFor(`new URLSearchParams(location.search).get('preset') === ${JSON.stringify(preset.value)} && !document.querySelector('.scope-progress')`, preset.label)
  report.interactions[preset.value] = await evaluate(`({ preset: new URLSearchParams(location.search).get('preset'), snapshot: Boolean(document.querySelector('.overview-snapshot')) })`)
}

const customEnd = matrixEnd
const shortStart = new Date(customEnd.getTime() - 30 * 60_000)
const longStart = new Date(customEnd.getTime() - 4 * 60 * 60_000)
await navigate(routeUrl('/overview', { preset: 'custom', fromUtc: shortStart.toISOString(), toUtc: customEnd.toISOString(), press: 'press5' }), routes[0].ready, 'short custom range')
await waitFor(`Boolean(document.querySelector('#press-summary-title')) && !document.querySelector('.scope-progress')`, 'short selected press range')
report.interactions.shortRange = await evaluate(`({ limitation: document.body.textContent.includes('longer than two hours'), telemetryQuality: document.querySelector('.timeline-quality-row')?.textContent, timeline: Boolean(document.querySelector('.synchronized-timeline')) })`)
await waitFor(`(() => {
  const timeline = document.querySelector('.overview-gantt .synchronized-timeline')
  if (!timeline) return false
  const labels = [...timeline.querySelectorAll('[aria-label]')].map((item) => item.getAttribute('aria-label'))
  return labels.some((label) => label === 'Radius recorded intervals')
    && labels.some((label) => label === 'Operational Group intervals')
    && labels.some((label) => label === 'Process Family intervals')
    && labels.some((label) => label === 'Physical Motion intervals')
    && labels.some((label) => label?.startsWith('Actual Speed.'))
    && labels.some((label) => label === 'Context changes event markers')
    && labels.some((label) => label === 'Physical Events event markers')
})()`, 'Overview full synchronized telemetry tracks')
report.interactions.overviewTelemetry = await evaluate(`(() => {
  const timeline = document.querySelector('.overview-gantt .synchronized-timeline')
  const labels = [...timeline.querySelectorAll('[aria-label]')].map((item) => item.getAttribute('aria-label'))
  return {
    context: ['Job', 'Order', 'Recipe', 'Customer', 'Material', 'Roll'].filter((name) => labels.includes(name + ' intervals')),
    contextMarkers: labels.includes('Context changes event markers'),
    radius: labels.includes('Radius recorded intervals'),
    group: labels.includes('Operational Group intervals'),
    family: labels.includes('Process Family intervals'),
    motion: labels.includes('Physical Motion intervals'),
    speed: labels.some((label) => label?.startsWith('Actual Speed.')),
    physicalEvents: labels.includes('Physical Events event markers'),
    eventMarkerCount: timeline.querySelectorAll('.synchronized-timeline__event').length,
  }
})()`)
await evaluate(`document.querySelector('.overview-gantt')?.scrollIntoView({ block: 'start' })`)
await delay(300)
await capture('1440-overview-telemetry')

report.interactions.overviewInlineEvidence = await evaluate(`({ selectedPeriod: Boolean(document.querySelector('.overview-selected-period')), noDrawerAction: !document.querySelector('.overview-selected-period .primary-action'), noDrawer: !document.querySelector('.evidence-drawer-shell'), radiusChanges: Boolean(document.querySelector('[aria-label="Radius raw-code changes event markers"]')) })`)
if (!report.interactions.overviewInlineEvidence.selectedPeriod || !report.interactions.overviewInlineEvidence.noDrawerAction || !report.interactions.overviewInlineEvidence.noDrawer) throw new Error('Overview evidence was not fully integrated on-page')

await navigate(routeUrl('/overview', { preset: 'custom', fromUtc: longStart.toISOString(), toUtc: customEnd.toISOString(), press: 'press5' }), routes[0].ready, 'long custom range')
await waitFor(`Boolean(document.querySelector('.overview-gantt .synchronized-timeline[aria-label*="complete selected-range synchronized evidence"]')) && !document.querySelector('.overview-gantt .scope-progress')`, 'long-range complete selected-range telemetry')
report.interactions.longRange = await evaluate(`({ coverage: document.querySelector('.telemetry-range-note')?.textContent, radiusTrack: Boolean(document.querySelector('[aria-label="Radius recorded intervals"]')), groupTrack: Boolean(document.querySelector('[aria-label="Operational Group intervals"]')), familyTrack: Boolean(document.querySelector('[aria-label="Process Family intervals"]')), completeTelemetry: Boolean(document.querySelector('.overview-gantt .synchronized-timeline[aria-label*="complete selected-range synchronized evidence"]')), focusedTelemetry: Boolean(document.querySelector('.overview-inline-telemetry')) })`)
if (!report.interactions.longRange.coverage?.includes('complete selected range') || !report.interactions.longRange.radiusTrack || !report.interactions.longRange.groupTrack || !report.interactions.longRange.familyTrack || !report.interactions.longRange.completeTelemetry || report.interactions.longRange.focusedTelemetry) throw new Error('Long-range integrated Overview evidence was incomplete')

await navigate(routeUrl('/operational-analysis', matrixRange), routes[1].ready, 'Operational occurrence evidence')
const occurrence = await evaluate(`Boolean(document.querySelector('.activity-evidence tbody tr'))`)
if (occurrence) {
  await waitFor(`Boolean(document.querySelector('.physical-signature-summary .synchronized-timeline[aria-label*="focused occurrence synchronized evidence"]'))`, 'default focused occurrence timeline')
  await waitFor(`(() => {
    const timeline = document.querySelector('.physical-signature-summary .synchronized-timeline[aria-label*="focused occurrence synchronized evidence"]')
    const labels = [...timeline.querySelectorAll('[aria-label]')].map((item) => item.getAttribute('aria-label'))
    return labels.includes('Radius recorded intervals')
      && labels.includes('Operational Group intervals')
      && labels.includes('Process Family intervals')
      && labels.includes('Physical Motion intervals')
      && labels.some((label) => label?.startsWith('Actual Speed.'))
      && labels.includes('Physical Events event markers')
  })()`, 'focused occurrence full synchronized telemetry tracks')
  const firstFocus = await evaluate(`document.querySelector('.activity-evidence tbody tr[aria-pressed="true"]')?.getAttribute('aria-label')`)
  const occurrenceCount = await evaluate(`document.querySelectorAll('.activity-evidence tbody tr').length`)
  if (occurrenceCount > 1) {
    await evaluate(`document.querySelectorAll('.activity-evidence tbody tr')[1]?.click()`)
    await waitFor(`document.querySelectorAll('.activity-evidence tbody tr')[1]?.getAttribute('aria-pressed') === 'true'`, 'occurrence focus switching')
  }
  report.interactions.operationalTelemetry = await evaluate(`(() => {
    const timeline = document.querySelector('.physical-signature-summary .synchronized-timeline[aria-label*="focused occurrence synchronized evidence"]')
    const labels = [...timeline.querySelectorAll('[aria-label]')].map((item) => item.getAttribute('aria-label'))
    return {
      focusedLabel: document.querySelector('.physical-signature-summary .eyebrow')?.textContent,
      initialFocus: ${JSON.stringify(firstFocus)},
      currentFocus: document.querySelector('.activity-evidence tbody tr[aria-pressed="true"]')?.getAttribute('aria-label'),
      radius: labels.includes('Radius recorded intervals'),
      group: labels.includes('Operational Group intervals'),
      family: labels.includes('Process Family intervals'),
      motion: labels.includes('Physical Motion intervals'),
      speed: labels.some((label) => label?.startsWith('Actual Speed.')),
      physicalEvents: labels.includes('Physical Events event markers'),
      summary: document.querySelector('.physical-signature-facts')?.textContent,
    }
  })()`)
  await evaluate(`document.querySelector('.physical-signature-summary')?.scrollIntoView({ block: 'start' })`)
  await delay(300)
  await capture('1440-operational-focused-telemetry')
  await evaluate(`document.querySelector('.physical-signature-summary .primary-action')?.click()`)
  await waitFor(`Boolean(document.querySelector('.evidence-drawer-shell'))`, 'occurrence drawer')
  report.interactions.occurrenceDrawer = await evaluate(`({ exact: document.body.textContent.includes('Radius recorded'), semantic: document.body.textContent.includes('ProcessIntelligence'), physical: document.body.textContent.includes('Physical telemetry evidence') })`)
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await waitFor(`!document.querySelector('.evidence-drawer-shell')`, 'occurrence drawer close')
}

await navigate(routeUrl('/patterns-episodes', matrixRange), routes[2].ready, 'Pattern Run evidence')
await waitFor(`Boolean(document.querySelector('tr[aria-label^="Open evidence for"]'))`, 'matched Run row')
await evaluate(`document.querySelector('tr[aria-label^="Open evidence for"]')?.click()`)
await waitFor(`Boolean(document.querySelector('.evidence-drawer-shell'))`, 'Run Evidence Drawer')
await waitFor(`(() => {
  const drawer = document.querySelector('.evidence-drawer-shell')
  const labels = [...drawer.querySelectorAll('[aria-label]')].map((item) => item.getAttribute('aria-label'))
  return labels.includes('Radius recorded intervals')
    && labels.includes('Operational Group intervals')
    && labels.includes('Process Family intervals')
    && labels.includes('Physical Motion intervals')
    && labels.some((label) => label?.startsWith('Actual Speed.'))
    && labels.includes('Context changes event markers')
    && labels.includes('Physical Events event markers')
})()`, 'unified Run telemetry timeline')
report.interactions.runTelemetry = await evaluate(`(() => {
  const drawer = document.querySelector('.evidence-drawer-shell')
  const labels = [...drawer.querySelectorAll('[aria-label]')].map((item) => item.getAttribute('aria-label'))
  return {
    timelineCount: drawer.querySelectorAll('.synchronized-timeline').length,
    focusedLongRun: drawer.textContent.includes('Focused two-hour telemetry window'),
    context: ['Job', 'Order', 'Recipe', 'Customer', 'Material', 'Roll'].filter((name) => labels.includes(name + ' intervals')),
    contextMarkers: labels.includes('Context changes event markers'),
    radius: labels.includes('Radius recorded intervals'),
    group: labels.includes('Operational Group intervals'),
    family: labels.includes('Process Family intervals'),
    motion: labels.includes('Physical Motion intervals'),
    speed: labels.some((label) => label?.startsWith('Actual Speed.')),
    physicalEvents: labels.includes('Physical Events event markers'),
  }
})()`)
await evaluate(`document.querySelector('.evidence-drawer-shell .synchronized-timeline')?.scrollIntoView({ block: 'start' })`)
await delay(300)
await capture('1440-pattern-run-telemetry')
await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
await waitFor(`!document.querySelector('.evidence-drawer-shell')`, 'Run drawer close')

await navigate(routeUrl('/intelligent-search', { q: 'Make Ready' }), `Boolean(document.querySelector('.search-result-list'))`, 'Search results')
for (const [key, selector, path] of [
  ['operationalLink', `a[href^="/operational-analysis"]`, '/operational-analysis'],
  ['patternsLink', `a[href^="/patterns-episodes"]`, '/patterns-episodes'],
  ['adminLink', `a[href^="/administration/state-classification"]`, '/administration/state-classification'],
]) {
  const href = await evaluate(`document.querySelector(${JSON.stringify(`.search-result-actions ${selector}`)})?.getAttribute('href')`)
  if (!href) throw new Error(`Search did not expose ${key}`)
  report.interactions[key] = href
  await navigate(new URL(href, applicationUrl).toString(), `location.pathname === ${JSON.stringify(path)}`, key)
  await command('Runtime.evaluate', { expression: 'history.back()' })
  await waitFor(`location.pathname === '/intelligent-search' && Boolean(document.querySelector('.search-result-list'))`, `${key} Back navigation`)
  await command('Runtime.evaluate', { expression: 'history.forward()' })
  await waitFor(`location.pathname === ${JSON.stringify(path)}`, `${key} Forward navigation`)
  await command('Runtime.evaluate', { expression: 'history.back()' })
  await waitFor(`location.pathname === '/intelligent-search' && Boolean(document.querySelector('.search-result-list'))`, `${key} return to Search`)
}

report.telemetry.press12Capabilities = await evaluate(`fetch('/api/telemetry/presses/press12/capabilities').then(async (response) => ({ status: response.status, body: await response.json() })).then(({ status, body }) => ({ status, unsupported: body.capabilities?.filter((item) => item.state === 'UNSUPPORTED').length ?? 0, unknown: body.capabilities?.filter((item) => item.state === 'UNKNOWN').length ?? 0 }))`)

const interception = await command('Page.addScriptToEvaluateOnNewDocument', { source: `{
  const actualFetch = window.fetch.bind(window)
  window.fetch = (input, init) => String(input instanceof Request ? input.url : input).includes('/api/telemetry/')
    ? Promise.resolve(new Response(JSON.stringify({ error: 'simulated_telemetry_unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } }))
    : actualFetch(input, init)
}` })
await navigate(routeUrl('/overview', { preset: 'custom', fromUtc: shortStart.toISOString(), toUtc: customEnd.toISOString(), press: 'press5' }), routes[0].ready, 'telemetry degradation simulation')
await waitFor(`document.body.textContent.includes('telemetry is temporarily unavailable') || document.body.textContent.includes('Some telemetry is temporarily unavailable')`, 'telemetry degradation fallback')
report.telemetry.degradedFallback = await evaluate(`({ radiusPage: Boolean(document.querySelector('.overview-snapshot')), radiusTrack: Boolean(document.querySelector('[aria-label="Radius recorded intervals"]')), warning: document.querySelector('.message--warning')?.textContent, fatal: Boolean(document.querySelector('.unavailable-panel')) })`)
await command('Page.removeScriptToEvaluateOnNewDocument', { identifier: interception.identifier })

report.performance = Object.fromEntries(Object.entries(report.matrix['1440']).map(([key, themes]) => [key, themes.light]))
if (consoleErrors.length) throw new Error(`Browser console errors: ${consoleErrors.join(' | ')}`)
socket.close()
console.log(JSON.stringify(report, null, 2))
