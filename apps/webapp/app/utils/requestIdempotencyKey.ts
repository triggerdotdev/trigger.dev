import { createHash } from "node:crypto";

export function scopeRequestIdempotencyKey(
  requestIdempotencyKey: string | null | undefined,
  scope: readonly string[]
): string | null | undefined {
  if (!requestIdempotencyKey) return requestIdempotencyKey;

  return createHash("sha256")
    .update(JSON.stringify([requestIdempotencyKey, ...scope]))
    .digest("hex");
}
