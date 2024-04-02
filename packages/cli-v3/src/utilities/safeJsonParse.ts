export function safeJsonParse(json?: string): unknown {
  if (!json) {
    return undefined;
  }

  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
