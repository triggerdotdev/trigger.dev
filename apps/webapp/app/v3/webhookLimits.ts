import { z } from "zod";

/**
 * An org's webhook limits, written by its plan and the admin back office. A field left unset uses the
 * env default, which is what self-hosted installs get.
 */
export const WebhookLimitsConfig = z.object({
  maxWaitersPerEnvironment: z.number().int().positive().optional(),
  maxWaitersPerEndpoint: z.number().int().positive().optional(),
  concurrency: z.number().int().positive().optional(),
});
export type WebhookLimitsConfig = z.infer<typeof WebhookLimitsConfig>;

export type WebhookLimits = Required<WebhookLimitsConfig>;

export function resolveWebhookLimits(
  config: unknown,
  defaults: WebhookLimits
): { limits: WebhookLimits; overrides: WebhookLimitsConfig } {
  const parsed = WebhookLimitsConfig.safeParse(config ?? {});
  const overrides = parsed.success ? parsed.data : {};
  return {
    limits: {
      maxWaitersPerEnvironment:
        overrides.maxWaitersPerEnvironment ?? defaults.maxWaitersPerEnvironment,
      maxWaitersPerEndpoint: overrides.maxWaitersPerEndpoint ?? defaults.maxWaitersPerEndpoint,
      concurrency: overrides.concurrency ?? defaults.concurrency,
    },
    overrides,
  };
}
