import {
  createIdempotencyKey,
  resetIdempotencyKey,
  type IdempotencyKey,
  type IdempotencyKeyInfo,
  type IdempotencyKeyScope,
} from "@trigger.dev/core/v3";

export const idempotencyKeys = {
  create: createIdempotencyKey,
  reset: resetIdempotencyKey,
};

export type { IdempotencyKey, IdempotencyKeyInfo, IdempotencyKeyScope };
