import { createHash } from 'node:crypto'
import type { RadiusPressKey } from '../radius/models.js'
import { JOB_ANALYSIS_DIMENSIONS, type JobAnalysisDimension } from './contracts.js'

export type JobResolvedIdentities = Partial<Record<JobAnalysisDimension, string>>

export function jobIdentityKey(values: JobResolvedIdentities): string {
  return JOB_ANALYSIS_DIMENSIONS.map((field) => `${field}=${values[field] ?? ''}`).join('\u0000')
}

export function naturalProductionRunId(pressKey: RadiusPressKey, startUtc: string, identities: JobResolvedIdentities): string {
  const evidence = `${new Date(startUtc).toISOString()}\u0000${jobIdentityKey(identities)}`
  return `${pressKey}.job.${createHash('sha256').update(evidence).digest('hex').slice(0, 16)}`
}

export function fragmentProductionRunId(pressKey: RadiusPressKey, boundaryCompleteness: string, startUtc: string, endUtc: string, identities: JobResolvedIdentities): string {
  const evidence = `${boundaryCompleteness}\u0000${new Date(startUtc).toISOString()}\u0000${new Date(endUtc).toISOString()}\u0000${jobIdentityKey(identities)}`
  return `${pressKey}.fragment.${createHash('sha256').update(evidence).digest('hex').slice(0, 16)}`
}
