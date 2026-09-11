import { createHash } from "node:crypto";
import { validate as uuidValidate, version as uuidVersion } from "uuid";

export function scopeRequestIdempotencyKey(
  requestIdempotencyKey: string | null | undefined,
  scope: readonly string[]
): string | undefined {
  if (!requestIdempotencyKey) return undefined;

  return createHash("sha256")
    .update(JSON.stringify([requestIdempotencyKey, ...scope]))
    .digest("hex");
}

export function scopeRequestIdempotencyHeader(
  requestIdempotencyKey: string | null | undefined,
  scope: readonly string[]
): string | undefined {
  if (!requestIdempotencyKey || !isValidV4UUID(requestIdempotencyKey)) return undefined;

  return scopeRequestIdempotencyKey(requestIdempotencyKey, scope);
}

function isValidV4UUID(uuid: string): boolean {
  return uuidValidate(uuid) && uuidVersion(uuid) === 4;
}
