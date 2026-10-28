// Credentials that can appear in run env vars or env overrides and must never reach debug logs.
const SECRET_ENV_KEYS = new Set(["TRIGGER_RUN_TOKEN", "TRIGGER_SECRET_KEY", "TRIGGER_JWT"]);

export function redactSecrets<T extends object>(values: T): T {
  const redacted = { ...values } as Record<string, unknown>;
  for (const key of Object.keys(redacted)) {
    if (SECRET_ENV_KEYS.has(key)) redacted[key] = "[redacted]";
  }
  return redacted as T;
}
