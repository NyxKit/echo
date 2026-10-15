export interface PromptTime { sentAt: string; timeZone: string }
export function validatePromptTime(value: unknown): PromptTime
export function createPromptTime(date?: Date, timeZone?: string): PromptTime
export function promptTimeContext(value: PromptTime): PromptTime & { localDateTime: string }
