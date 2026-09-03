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
  throw new Error('Browser remote-debugging page was not available')
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

async function waitFor(expression, label) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try { if (await evaluate(expression)) return } catch {}
    await delay(250)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function navigate(path, readyExpression, label) {
  const url = new URL(path, applicationUrl)
  await command('Page.navigate', { url: url.toString() })
  await waitFor(`document.readyState === 'complete' && (${readyExpression})`, label)
}

async function setTheme(theme) {
  if ((await evaluate('document.documentElement.dataset.theme')) !== theme) await evaluate(`document.querySelector('.theme-toggle')?.click()`)
  await waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`, `${theme} theme`)
}

async function capture(name) {
  if (!screenshotDirectory) return
  const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(join(screenshotDirectory, `${name}.png`), Buffer.from(screenshot.data, 'base64'))
}

await command('Page.enable')
await command('Runtime.enable')
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true })

const routes = [
  { key: 'overview', path: '/overview', ready: `Boolean(document.querySelector('.overview-snapshot'))` },
  { key: 'machine', path: '/machine-intelligence', ready: `Boolean(document.querySelector('.mi-page'))` },
  { key: 'stops', path: '/stop-intelligence', ready: `Boolean(document.querySelector('.si-page'))` },
  { key: 'radius', path: '/raw-radius-explorer', ready: `Boolean(document.querySelector('.raw-radius-explorer-page'))` },
  { key: 'telemetry', path: '/telemetry-event-explorer', ready: `Boolean(document.querySelector('.telemetry-event-explorer-page'))` },
  { key: 'admin', path: '/administration/state-classification', ready: `Boolean(document.querySelector('.classification-admin-page'))` },
]
const viewports = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
]
const report = { matrix: {}, consoleErrors }

for (const viewport of viewports) {
  report.matrix[viewport.name] = {}
  await command('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.width < 600 })
  for (const route of routes) {
    await navigate(route.path, route.ready, `${route.key} at ${viewport.name}`)
    report.matrix[viewport.name][route.key] = {}
    for (const theme of ['light', 'dark']) {
      await setTheme(theme)
      const result = await evaluate(`({
        path: location.pathname,
        title: document.querySelector('h1')?.textContent,
        theme: document.documentElement.dataset.theme,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        dialogCount: document.querySelectorAll('[role=dialog]').length,
      })`)
      if (result.overflow) throw new Error(`${route.key} has page-level horizontal overflow at ${viewport.name} in ${theme} theme`)
      report.matrix[viewport.name][route.key][theme] = result
      await capture(`${viewport.name}-${route.key}-${theme}`)
    }
  }
}

socket.close()
if (consoleErrors.length) throw new Error(`Browser console errors: ${consoleErrors.join(' | ')}`)
console.log(JSON.stringify(report, null, 2))
