export type TimeScope = '24h' | '48h' | 'week' | 'month' | 'year'
export const timeWindows: Readonly<Record<TimeScope, number>>
export const contextChoices: (TimeScope | 'full' | 'selected')[]
export function isTimeScope(scope: string): scope is TimeScope
export function contextLabel(scope: string, attached?: boolean): string
export function timeWindowIndexes(messages: { timestamp: number | null }[], selectedIndexes: number[], scope: TimeScope): number[]
