export function responseEvents(body: ReadableStream<Uint8Array>, maxBytes?: number): AsyncGenerator<{ type: string; delta?: string; message?: string; status?: string }>
