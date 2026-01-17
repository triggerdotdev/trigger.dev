import { IdempotencyKeyOptionsSchema } from "../schemas/api.js";

/**
 * Safely parses idempotencyKeyOptions from a database record and extracts the user-provided key.
 * Returns the user-provided key if valid options exist, otherwise falls back to the hash.
 *
 * @param run - Object containing idempotencyKey (the hash) and idempotencyKeyOptions (JSON from DB)
 * @returns The user-provided key, the hash as fallback, or null if neither exists
 */
export function getUserProvidedIdempotencyKey(run: {
  idempotencyKey: string | null;
  idempotencyKeyOptions: unknown;
}): string | null {
  const parsed = IdempotencyKeyOptionsSchema.safeParse(run.idempotencyKeyOptions);
  if (parsed.success) {
    return parsed.data.key;
  }
  return run.idempotencyKey;
}

/**
 * Safely parses idempotencyKeyOptions and extracts the scope.
 *
 * @param run - Object containing idempotencyKeyOptions (JSON from DB)
 * @returns The scope if valid options exist, otherwise undefined
 */
export function getIdempotencyKeyScope(run: {
  idempotencyKeyOptions: unknown;
}): "run" | "attempt" | "global" | undefined {
  const parsed = IdempotencyKeyOptionsSchema.safeParse(run.idempotencyKeyOptions);
  if (parsed.success) {
    return parsed.data.scope;
  }
  return undefined;
}

/**
 * Extracts just the user-provided key from idempotencyKeyOptions, without falling back to the hash.
 * Useful for ClickHouse replication where we want to store only the explicit user key.
 *
 * @param run - Object containing idempotencyKeyOptions (JSON from DB)
 * @returns The user-provided key if valid options exist, otherwise undefined
 */
export function extractIdempotencyKeyUser(run: {
  idempotencyKeyOptions: unknown;
}): string | undefined {
  const parsed = IdempotencyKeyOptionsSchema.safeParse(run.idempotencyKeyOptions);
  if (parsed.success) {
    return parsed.data.key;
  }
  return undefined;
}
