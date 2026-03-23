const ALLOWED_TRIGGER_SOURCES = new Set(["sdk", "cli", "mcp"]);

/** Validates a client-provided trigger source header against the allowlist. */
export function sanitizeTriggerSource(value: string | null | undefined): string | undefined {
  if (value && ALLOWED_TRIGGER_SOURCES.has(value)) {
    return value;
  }
  return undefined;
}
