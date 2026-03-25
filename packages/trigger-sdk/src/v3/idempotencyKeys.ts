import { createIdempotencyKey, resetIdempotencyKey, type IdempotencyKey } from "@trigger.dev/core/v3";

export const idempotencyKeys = {
  create: createIdempotencyKey,
  reset: resetIdempotencyKey,
};

export type { IdempotencyKey };
