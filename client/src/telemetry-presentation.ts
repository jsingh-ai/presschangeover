export function safeTelemetrySourceUnit(signal?: { sourceUnit?: string | null }): string | null {
  const unit = signal?.sourceUnit?.trim()
  return unit && !/^\d+$/.test(unit) ? unit : null
}
