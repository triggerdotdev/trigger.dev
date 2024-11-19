import { createIdempotencyKey, type IdempotencyKey } from "@trigger.dev/core/v3";

export const idempotencyKeys = {
  create: createIdempotencyKey,
};

export type { IdempotencyKey };
