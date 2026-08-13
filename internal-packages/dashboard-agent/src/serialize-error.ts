/** A raw Error serializes to `{}` in structured logs, so log its fields. */
export function serializeError(error: unknown): { message: string; stack?: string } | string {
  return error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
}
