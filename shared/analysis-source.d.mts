import type { AnalysisContext } from './analysis-policy.mjs'
export function compactJson(text: string): string
export function scopedSourceParts(sourceParts: string[], contexts: AnalysisContext[]): string[]
export function sourceText(sourceParts: string[]): string
export function sourceMessageRecords(source: string): string[]
export function sourceMetadata(source: string): string

export function sourceFields(source: string): Record<string, string>
export function sourceRecordEntries(source: string): [string, string][]
export function sourceArrayEntries(source: string): string[]
