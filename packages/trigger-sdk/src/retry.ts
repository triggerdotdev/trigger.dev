import type { RetryOptions } from "@trigger.dev/core";
import { calculateRetryAt } from "@trigger.dev/core";

export { calculateRetryAt };
export type { RetryOptions };

export const retry = {
  standardBackoff: {
    limit: 8,
    factor: 1.8,
    minTimeoutInMs: 500,
    maxTimeoutInMs: 30000,
    randomize: true,
  },
} as const satisfies Record<string, RetryOptions>;
