import { WORKER_HEADERS } from "@trigger.dev/core/v3/workers";

// Secret-bearing headers to drop before logging request headers.
// Dependency-free so the redaction is unit-tested directly.
export const SENSITIVE_WORKER_HEADERS = new Set([
  "authorization",
  "cookie",
  WORKER_HEADERS.MANAGED_SECRET.toLowerCase(),
]);

/**
 * Copy `headers` into a plain object, dropping any header whose (lower-cased)
 * name is in `denylist`. Used before logging request headers.
 */
export function sanitizeWorkerHeaders(
  headers: Headers,
  denylist: ReadonlySet<string> = SENSITIVE_WORKER_HEADERS
): Partial<Record<string, string>> {
  const skip = new Set(Array.from(denylist, (h) => h.toLowerCase()));
  const sanitized: Partial<Record<string, string>> = {};
  for (const [key, value] of headers.entries()) {
    if (!skip.has(key.toLowerCase())) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
