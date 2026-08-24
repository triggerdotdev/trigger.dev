declare global {
  interface String {
    toWellFormed(): string;
  }
}

/** Postgres jsonb rejects a lone surrogate, so one in the text fails the persist every retry. */
export function wellFormMessageText(parts: unknown): void {
  if (!Array.isArray(parts)) return;

  for (const part of parts) {
    const text = (part as { text?: unknown } | null)?.text;
    if (typeof text === "string") {
      (part as { text: string }).text = text.toWellFormed();
    }
  }
}
