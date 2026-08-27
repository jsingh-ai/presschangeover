import { DateTime } from 'luxon'

export const PLANT_TIME_ZONE = 'America/Chicago'
export const MAX_CUSTOM_RANGE_MS = 31 * 24 * 60 * 60 * 1_000

export type RangePreset = 'today' | 'last24' | 'custom'

export interface SelectedRange {
  preset: RangePreset
  fromUtc: string
  toUtc: string
  customFromLocal?: string
  customToLocal?: string
}

export class RangeValidationError extends Error {}

function parsePlantLocal(value: string, label: string): DateTime {
  if (!value) throw new RangeValidationError(`${label} is required.`)
  const parsed = DateTime.fromISO(value, {
    zone: PLANT_TIME_ZONE,
    setZone: true,
  })
  if (
    !parsed.isValid ||
    parsed.toFormat("yyyy-MM-dd'T'HH:mm") !== value
  ) {
    throw new RangeValidationError(
      `${label} is not a valid plant-local date and time.`,
    )
  }
  if (parsed.getPossibleOffsets().length > 1) {
    throw new RangeValidationError(
      `${label} is ambiguous during the daylight-saving transition. Choose a time outside the repeated hour.`,
    )
  }
  return parsed
}

export function createPresetRange(
  preset: Exclude<RangePreset, 'custom'>,
  now: DateTime = DateTime.now(),
): SelectedRange {
  const plantNow = now.setZone(PLANT_TIME_ZONE)
  const from =
    preset === 'today'
      ? plantNow.startOf('day').toUTC()
      : plantNow.toUTC().minus({ hours: 24 })
  return {
    preset,
    fromUtc: from.toISO()!,
    toUtc: plantNow.toUTC().toISO()!,
  }
}

export function createCustomRange(
  fromLocal: string,
  toLocal: string,
): SelectedRange {
  const from = parsePlantLocal(fromLocal, 'Custom start')
  const to = parsePlantLocal(toLocal, 'Custom end')
  const durationMs = to.toMillis() - from.toMillis()
  if (durationMs <= 0) {
    throw new RangeValidationError('Custom end must be after custom start.')
  }
  if (durationMs > MAX_CUSTOM_RANGE_MS) {
    throw new RangeValidationError('Custom range cannot exceed 31 days.')
  }
  return {
    preset: 'custom',
    fromUtc: from.toUTC().toISO()!,
    toUtc: to.toUTC().toISO()!,
    customFromLocal: fromLocal,
    customToLocal: toLocal,
  }
}

export function restoreSelectedRange(
  fromUtc: string | null,
  toUtc: string | null,
  presetValue: string | null,
): SelectedRange | undefined {
  if (!fromUtc || !toUtc) return undefined
  const from = DateTime.fromISO(fromUtc, { zone: 'utc', setZone: true })
  const to = DateTime.fromISO(toUtc, { zone: 'utc', setZone: true })
  const durationMs = to.toMillis() - from.toMillis()
  if (!from.isValid || !to.isValid || durationMs <= 0 || durationMs > MAX_CUSTOM_RANGE_MS) {
    return undefined
  }
  const preset: RangePreset = presetValue === 'today' || presetValue === 'last24'
    ? presetValue
    : 'custom'
  return {
    preset,
    fromUtc: from.toUTC().toISO()!,
    toUtc: to.toUTC().toISO()!,
    ...(preset === 'custom'
      ? {
          customFromLocal: from.setZone(PLANT_TIME_ZONE).toFormat("yyyy-MM-dd'T'HH:mm"),
          customToLocal: to.setZone(PLANT_TIME_ZONE).toFormat("yyyy-MM-dd'T'HH:mm"),
        }
      : {}),
  }
}

export function formatPlantDateTime(value: string): string {
  return DateTime.fromISO(value, { zone: 'utc' })
    .setZone(PLANT_TIME_ZONE)
    .toFormat('MMM d, h:mm:ss a')
}

export function formatPlantDateTimeCt(value: string): string {
  return `${formatPlantDateTime(value)} CT`
}

export function formatSelectedRange(range: SelectedRange): string {
  return `${formatPlantDateTime(range.fromUtc)} – ${formatPlantDateTime(range.toUtc)} CT`
}

export function defaultCustomValues(now: DateTime = DateTime.now()): {
  from: string
  to: string
} {
  const plantNow = now.setZone(PLANT_TIME_ZONE).startOf('minute')
  return {
    from: plantNow.minus({ hours: 8 }).toFormat("yyyy-MM-dd'T'HH:mm"),
    to: plantNow.toFormat("yyyy-MM-dd'T'HH:mm"),
  }
}
