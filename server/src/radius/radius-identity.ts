import type { RadiusStateSegment } from './models.js'

export function exactRadiusIdentity(
  value: Pick<RadiusStateSegment, 'eventType' | 'statusCode' | 'statusDescription'>,
): string {
  return [value.eventType, value.statusCode ?? '', value.statusDescription].join('\u001f')
}
