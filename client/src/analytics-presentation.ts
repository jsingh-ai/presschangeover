import type { OperationalRelationshipOutcome } from './types/api'

export function supportText(numerator: number, denominator: number): string {
  const percentage = denominator === 0 ? 0 : (numerator / denominator) * 100
  return `${numerator}/${denominator} · ${percentage.toFixed(1)}%`
}

export function relationshipStrength(outcome: Pick<OperationalRelationshipOutcome, 'numerator' | 'denominator' | 'percentage'>): string {
  if (outcome.denominator === 0 || outcome.numerator === 0) return 'Not observed'
  if (outcome.percentage === 100 && outcome.denominator >= 10) return 'Consistent in range'
  if (outcome.percentage >= 60) return 'Dominant'
  if (outcome.percentage >= 40) return 'Common'
  if (outcome.percentage >= 15) return 'Occasional'
  return 'Rare'
}

export function categoryClass(eventType: string): string {
  if (eventType === 'G') return 'good'
  if (eventType === 'M') return 'make-ready'
  if (eventType === 'B') return 'bad'
  if (eventType === 'S') return 'safety'
  return 'other'
}

export function statusLabel(status: { statusCode: string | null; statusDescription: string }): string {
  return status.statusCode ? `${status.statusDescription} · ${status.statusCode}` : status.statusDescription
}
