export function safeJsonParse(json?: string): unknown {
  if (!json) {
    return;
  }

  try {
    return JSON.parse(json);
  } catch (_e) {
    return null;
  }
}
