import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, request as upstreamRequest } from 'node:http'
import { extname, resolve, sep } from 'node:path'

const clientRoot = resolve(process.argv[2] ?? '')
const port = Number(process.argv[3] ?? 8101)
const production = new URL(process.argv[4] ?? 'http://10.8.10.97:8088')
const candidate = new URL(process.argv[5] ?? 'http://127.0.0.1:8091')
const candidatePaths = ['/api/telemetry/radius-timing-analysis', '/api/telemetry/fleet-speed-context']
if (!existsSync(clientRoot) || !statSync(clientRoot).isDirectory()) throw new Error('A staged client directory is required')
const contentTypes = new Map([['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'], ['.png', 'image/png'], ['.svg', 'image/svg+xml'], ['.woff2', 'font/woff2']])
const isCandidate = (pathname) => candidatePaths.includes(pathname) || /^\/api\/telemetry\/presses\/press\d+\/stop-restart-analysis$/.test(pathname)

const server = createServer((incoming, response) => {
  const url = new URL(incoming.url ?? '/', 'http://staging.local')
  if (url.pathname.startsWith('/api/')) {
    const upstream = isCandidate(url.pathname) ? candidate : production
    const proxied = upstreamRequest({ protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, method: incoming.method, path: `${url.pathname}${url.search}`, headers: { ...incoming.headers, host: upstream.host } }, (upstreamResponse) => { response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers); upstreamResponse.pipe(response) })
    proxied.on('error', () => { response.writeHead(502, { 'Content-Type': 'application/json' }); response.end('{"error":"staging_upstream_unavailable"}') })
    incoming.pipe(proxied); return
  }
  let relativePath
  try { relativePath = decodeURIComponent(url.pathname).replace(/^[/\\]+/, '') } catch { response.writeHead(400); response.end(); return }
  let filePath = resolve(clientRoot, relativePath || 'index.html')
  if (filePath !== clientRoot && !filePath.startsWith(`${clientRoot}${sep}`)) { response.writeHead(403); response.end(); return }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) filePath = resolve(clientRoot, 'index.html')
  response.writeHead(200, { 'Content-Type': contentTypes.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream', 'Cache-Control': 'no-store' }); createReadStream(filePath).pipe(response)
})
server.listen(port, '127.0.0.1', () => console.log(`Phase 3 staged client available at http://127.0.0.1:${port}`))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)))
