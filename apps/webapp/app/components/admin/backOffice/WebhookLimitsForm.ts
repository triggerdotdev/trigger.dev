import { z } from "zod";

const OptionalLimit = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  z.coerce.number().int().min(1).max(2_147_483_647).optional()
);

const OptionalRetention = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  z.coerce.number().int().min(1).max(365).optional()
);

const OptionalWindowSeconds = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  z.coerce.number().int().min(1).max(3600).optional()
);

const OptionalBytes = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional()
);

const OptionalFlag = z.preprocess(
  (value) => (value === "on" ? true : undefined),
  z.literal(true).optional()
);

export const WEBHOOK_LIMITS_INTENT = "set-webhook-limits";

const SetWebhookLimitsSchema = z.object({
  intent: z.literal(WEBHOOK_LIMITS_INTENT),
  maxWaitersPerEnvironment: OptionalLimit,
  maxWaitersPerEndpoint: OptionalLimit,
  concurrency: OptionalLimit,
  deliveryRetentionDays: OptionalRetention,
  deliveryRetentionStrict: OptionalFlag,
  endpointRateLimitTokens: OptionalLimit,
  endpointRateLimitWindowSeconds: OptionalWindowSeconds,
  environmentRateLimitTokens: OptionalLimit,
  environmentRateLimitWindowSeconds: OptionalWindowSeconds,
  queuedPayloadBytes: OptionalBytes,
});

/** The back-office webhook limits form, parsed, or the field errors to show. */
export function parseWebhookLimitsForm(formData: FormData) {
  return SetWebhookLimitsSchema.safeParse(Object.fromEntries(formData));
}
