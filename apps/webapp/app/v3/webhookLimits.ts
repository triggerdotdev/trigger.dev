import {
  WEBHOOK_DELIVERY_RETENTION_CLASSES,
  webhookDeliveryRetentionClassAtLeast,
} from "@trigger.dev/core/v3/isomorphic";
import { z } from "zod";

/**
 * An org's webhook limits, written by its plan and the admin back office. A field left unset uses the
 * env default, which is what self-hosted installs get.
 */
export const WebhookLimitsConfig = z.object({
  maxWaitersPerEnvironment: z.number().int().positive().optional(),
  maxWaitersPerEndpoint: z.number().int().positive().optional(),
  concurrency: z.number().int().positive().optional(),
  /** How many days of deliveries the org can see. Older ones are hidden at read time. */
  deliveryRetentionDays: z.number().int().positive().optional(),
  /**
   * Store deliveries only as long as `deliveryRetentionDays` (rounded up to a retention class), so
   * they are deleted then, instead of keeping them for the default storage period and hiding them.
   */
  deliveryRetentionStrict: z.boolean().optional(),
  /** Requests one endpoint accepts per window before the ingress answers 429. */
  endpointRateLimitTokens: z.number().int().positive().optional(),
  endpointRateLimitWindowSeconds: z.number().int().positive().optional(),
  /**
   * Tokens one environment's endpoints accept together per window before the ingress answers 429.
   * A request costs one token per started 64 KiB of body, so this bounds bytes as well as requests.
   */
  environmentRateLimitTokens: z.number().int().positive().optional(),
  environmentRateLimitWindowSeconds: z.number().int().positive().optional(),
  /** The most webhook job payload bytes one environment may have waiting to be delivered. */
  queuedPayloadBytes: z.number().int().positive().optional(),
});
export type WebhookLimitsConfig = z.infer<typeof WebhookLimitsConfig>;

export type WebhookLimits = Required<WebhookLimitsConfig> & {
  /** The retention class new deliveries are stored in: never shorter than what the org can see. */
  deliveryStorageDays: number;
};

export type WebhookLimitsDefaults = Omit<WebhookLimits, "deliveryRetentionStrict">;

const MAX_RETENTION_DAYS = Math.max(...WEBHOOK_DELIVERY_RETENTION_CLASSES.map((c) => c.days));

export function resolveWebhookLimits(
  config: unknown,
  defaults: WebhookLimitsDefaults
): { limits: WebhookLimits; overrides: WebhookLimitsConfig } {
  const parsed = WebhookLimitsConfig.safeParse(config ?? {});
  const overrides = parsed.success ? parsed.data : {};
  const retentionDays = Math.min(
    overrides.deliveryRetentionDays ?? defaults.deliveryRetentionDays,
    MAX_RETENTION_DAYS
  );
  const strict = overrides.deliveryRetentionStrict ?? false;
  return {
    limits: {
      maxWaitersPerEnvironment:
        overrides.maxWaitersPerEnvironment ?? defaults.maxWaitersPerEnvironment,
      maxWaitersPerEndpoint: overrides.maxWaitersPerEndpoint ?? defaults.maxWaitersPerEndpoint,
      concurrency: overrides.concurrency ?? defaults.concurrency,
      deliveryRetentionDays: retentionDays,
      deliveryRetentionStrict: strict,
      deliveryStorageDays: webhookDeliveryRetentionClassAtLeast(
        strict ? retentionDays : Math.max(retentionDays, defaults.deliveryStorageDays)
      ).days,
      endpointRateLimitTokens:
        overrides.endpointRateLimitTokens ?? defaults.endpointRateLimitTokens,
      endpointRateLimitWindowSeconds:
        overrides.endpointRateLimitWindowSeconds ?? defaults.endpointRateLimitWindowSeconds,
      environmentRateLimitTokens:
        overrides.environmentRateLimitTokens ?? defaults.environmentRateLimitTokens,
      environmentRateLimitWindowSeconds:
        overrides.environmentRateLimitWindowSeconds ?? defaults.environmentRateLimitWindowSeconds,
      queuedPayloadBytes: overrides.queuedPayloadBytes ?? defaults.queuedPayloadBytes,
    },
    overrides,
  };
}
