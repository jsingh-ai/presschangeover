import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { open, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
export const JOB_HISTORY_MATERIALIZATION_LOCK_PATH = join(tmpdir(), 'process-intelligence-job-materialization.lock')
export const DEFAULT_PRODUCTION_PROCESS_INTELLIGENCE_URL = 'http://10.8.10.97:8088'

export interface ProcessIdentity { pid: number; name: string; commandLine: string }
export interface MaterializationPreflight { serviceState: 'Stopped'; release(): Promise<void> }

export async function assertMaterializationProductionHealth(
  baseUrl: string,
  request: (url: string) => Promise<{ status: number }> = (url) => fetch(url),
) {
  const parsed = new URL(baseUrl)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('invalid_materialization_production_url')
  const origin = parsed.toString().replace(/\/$/, '')
  const application = await request(`${origin}/api/health`)
  if (application.status !== 200) throw new Error(`production_health_degraded:application:${application.status}`)
  const radius = await request(`${origin}/api/radius/health`)
  if (radius.status !== 200) throw new Error(`production_health_degraded:radius:${radius.status}`)
  return { application: application.status, radius: radius.status }
}

export function knownMaterializationConsumers(processes: ProcessIdentity[], ownPid = process.pid): ProcessIdentity[] {
  return processes.filter(({ pid, name, commandLine }) => {
    if (pid === ownPid) return false
    const executable = name.toLocaleLowerCase(); const command = commandLine.toLocaleLowerCase()
    if (executable === 'node.exe' || executable === 'node') return /job-intelligence-validation-host|representative-validation|job-intelligence-ui-smoke|job-intelligence[\\/](?:backfill|representative-validation)/.test(command)
    if (!['msedge.exe', 'chrome.exe', 'msedge', 'chrome', 'chromium'].includes(executable) || !command.includes('--headless')) return false
    return /processintelligence[\\/]staging[\\/]|appdata[\\/]local[\\/]temp[\\/]pi-/.test(command)
  })
}

export function knownProductionWebConsumers(processes: ProcessIdentity[], ownPid = process.pid): ProcessIdentity[] {
  return processes.filter(({ pid, name, commandLine }) => pid !== ownPid && ['node.exe', 'node'].includes(name.toLocaleLowerCase()) && /processintelligence[\\/]app[\\/]server[\\/]dist[\\/](?:index|start)\.js/i.test(commandLine))
}

async function systemProcesses(): Promise<ProcessIdentity[]> {
  if (process.platform === 'win32') {
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','msedge.exe','chrome.exe') } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 })
    const parsed = stdout.trim() ? JSON.parse(stdout) as Record<string, unknown> | Record<string, unknown>[] : []
    return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({ pid: Number(item.ProcessId), name: String(item.Name ?? ''), commandLine: String(item.CommandLine ?? '') })).filter((item) => Number.isSafeInteger(item.pid))
  }
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,comm=,args='], { maxBuffer: 2 * 1024 * 1024 })
  return stdout.split(/\r?\n/).flatMap((line) => { const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/); return match ? [{ pid: Number(match[1]), name: match[2]!, commandLine: match[3]! }] : [] })
}

function pidIsAlive(pid: number) { try { process.kill(pid, 0); return true } catch { return false } }

async function systemServiceState(): Promise<string> {
  if (process.platform !== 'win32') throw new Error('job_history_materialization_requires_windows_service_gate')
  const script = `(Get-Service -Name 'ProcessIntelligence.Node' -ErrorAction Stop).Status.ToString()`
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 32 * 1024 })
  return stdout.trim()
}

export async function acquireMaterializationPreflight(options: { maintenanceMode?: boolean; lockPath?: string; listProcesses?: () => Promise<ProcessIdentity[]>; serviceState?: () => Promise<string>; ownPid?: number } = {}): Promise<MaterializationPreflight> {
  if (!options.maintenanceMode) throw new Error('job_history_explicit_maintenance_mode_required')
  const serviceState = await (options.serviceState ?? systemServiceState)()
  if (serviceState !== 'Stopped') throw new Error(`job_history_materialization_service_must_be_stopped:${serviceState || 'Unknown'}`)
  const lockPath = options.lockPath ?? JOB_HISTORY_MATERIALIZATION_LOCK_PATH; const ownPid = options.ownPid ?? process.pid; const token = randomUUID(); const payload = JSON.stringify({ pid: ownPid, token })
  let handle
  try { handle = await open(lockPath, 'wx') }
  catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
    let prior: { pid?: number } = {}
    try { prior = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: number } } catch { throw new Error('job_history_materialization_lock_unreadable') }
    if (!Number.isSafeInteger(prior.pid) || pidIsAlive(prior.pid!)) throw new Error('job_history_materialization_lock_active')
    await unlink(lockPath)
    handle = await open(lockPath, 'wx')
  }
  await handle.writeFile(payload, 'utf8'); await handle.close()
  let released = false
  const release = async () => { if (released) return; released = true; try { if (await readFile(lockPath, 'utf8') === payload) await unlink(lockPath) } catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error } }
  try {
    const processes = await (options.listProcesses ?? systemProcesses)()
    const web = knownProductionWebConsumers(processes, ownPid)
    if (web.length) throw new Error(`job_history_production_web_process_active:${web.map(({ pid }) => pid).join(',')}`)
    const blockers = knownMaterializationConsumers(processes, ownPid)
    if (blockers.length) throw new Error(`job_history_materialization_consumers_active:${blockers.map(({ pid }) => pid).join(',')}`)
    return { serviceState: 'Stopped', release }
  } catch (error) { await release(); throw error }
}
