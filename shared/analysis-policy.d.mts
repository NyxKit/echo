import type { TimeScope } from './context-windows.mjs'
export interface AnalysisImage { reference: string; dataUrl: string; width: number; height: number }
export type ContextScope = 'selected' | 'surrounding' | 'full' | TimeScope
export type AnalysisContext = { scope: 'full' | 'discussion' } | { scope: 'selected' | 'surrounding' | TimeScope; references: string[] }
export const contextScopes: ContextScope[]
export interface AnalysisInput { question: string; focus: string[]; context: AnalysisContext; images: AnalysisImage[]; excluded: { reference: string; reason: string }[] }
export interface AnalysisPayload {
  requestId: string; model: string; sourceVersion: string; contextVersion: string; sourceParts: string[];
  history: (AnalysisInput & { answer: string })[]; turn: AnalysisInput
}
export function isAnalysisModel(value: unknown): value is string
export const imageLimit: number
export const requestByteLimit: number
export const instructions: string
export function validateAnalysis(payload: unknown): AnalysisPayload
export function analysisRequest(payload: AnalysisPayload): { model: string; store: false; stream: true; tools: never[]; instructions: string; input: unknown[] }
