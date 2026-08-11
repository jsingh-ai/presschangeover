import { writeFile } from 'node:fs/promises'

const debuggerUrl = process.argv[2] ?? 'http://127.0.0.1:9226'
const applicationUrl = process.argv[3] ?? 'http://127.0.0.1:4174/administration/state-classification'
const screenshotBase = process.argv[4]
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
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (!message.id) return
  const handler = pending.get(message.id)
  if (!handler) return
  pending.delete(message.id)
  if (message.error) handler.reject(new Error(message.error.message)); else handler.resolve(message.result)
})
function command(method, params = {}) { const id = nextId++; socket.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => pending.set(id, { resolve, reject })) }
async function evaluate(expression) { const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value }
async function waitFor(expression, label) { for (let attempt = 0; attempt < 120; attempt += 1) { try { if (await evaluate(expression)) return } catch {} await delay(250) } throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(await evaluate(`({url:location.href,title:document.querySelector('h1')?.textContent,error:document.querySelector('.unavailable-panel')?.textContent,status:document.querySelector('[role=status]')?.textContent})`))}`) }
async function capture(path) { const image = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(path, Buffer.from(image.data, 'base64')) }

await command('Page.enable')
await command('Runtime.enable')
await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
await command('Page.navigate', { url: applicationUrl })
await waitFor(`Boolean(document.querySelector('.classification-columns')) && document.querySelectorAll('.classification-column').length === 8 && document.querySelectorAll('.classification-card').length > 0`, 'classification administration workspace')

const report = {}
report.desktop = await evaluate(`({
  title: document.querySelector('.classification-hero h1')?.textContent,
  path: location.pathname,
  navigationItems: document.querySelectorAll('.primary-nav-link').length,
  groups: document.querySelectorAll('.classification-column').length,
  cards: document.querySelectorAll('.classification-card').length,
  reviewCards: document.querySelectorAll('.classification-card.needs-review').length,
  rawIdentity: document.querySelector('.classification-card-main')?.textContent.trim(),
  readOnly: Boolean(document.querySelector('.classification-permission')),
  publishDisabled: document.querySelector('.classification-actions .primary-action')?.disabled,
  internalBoardScroll: document.querySelector('.classification-columns').scrollWidth >= document.querySelector('.classification-columns').clientWidth,
  pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  theme: document.documentElement.dataset.theme,
})`)
if (screenshotBase) await capture(`${screenshotBase}-desktop.png`)

await evaluate(`document.querySelector('.theme-toggle').click()`)
await delay(250)
report.alternateTheme = await evaluate(`({theme:document.documentElement.dataset.theme, body:getComputedStyle(document.body).backgroundColor, panel:getComputedStyle(document.querySelector('.classification-board')).backgroundColor, pageOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth})`)

await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
await delay(350)
report.mobile = await evaluate(`({width:innerWidth, clientWidth:document.documentElement.clientWidth, scrollWidth:document.documentElement.scrollWidth, pageOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth, boardClient:document.querySelector('.classification-columns').clientWidth, boardScroll:document.querySelector('.classification-columns').scrollWidth, internalBoardScroll:document.querySelector('.classification-columns').scrollWidth>document.querySelector('.classification-columns').clientWidth, actionsVisible:Boolean(document.querySelector('.classification-actions')), groups:document.querySelectorAll('.classification-column').length})`)
if (screenshotBase) await capture(`${screenshotBase}-mobile.png`)

await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
await evaluate(`document.querySelector('.primary-nav-link').click()`)
await waitFor(`Boolean(document.querySelector('.operational-panel .timeline-view-toggle')) && document.querySelectorAll('.timeline-row').length === 12`, 'semantic fleet timeline')
report.timeline = await evaluate(`(() => {
  const buttons=[...document.querySelectorAll('.operational-panel .timeline-view-toggle button')]
  const before=document.querySelectorAll('.timeline-segment').length
  const semantic=document.querySelector('.timeline-segment[data-view=operations]')
  const semanticBackground=semantic?getComputedStyle(semantic).backgroundColor:null
  buttons.find((button)=>button.textContent.includes('Raw Radius'))?.click()
  return {buttons:buttons.map((button)=>button.textContent.trim()), before, semanticBackground}
})()`)
await waitFor(`Boolean(document.querySelector('.timeline-segment[data-view=raw]'))`, 'Raw Radius timeline view')
Object.assign(report.timeline, await evaluate(`({after:document.querySelectorAll('.timeline-segment').length, rawAccessibleIdentity:document.querySelector('.timeline-segment[data-view=raw]')?.getAttribute('aria-label'), offlineDistinct:Boolean(document.querySelector('.timeline-segment--offline')), pageOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth})`))

socket.close()
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
