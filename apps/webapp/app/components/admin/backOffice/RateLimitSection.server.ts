import { z } from "zod";
import {
  RateLimitTokenBucketConfig,
  RateLimiterConfig,
} from "~/services/authorizationRateLimitMiddleware.server";
import {
  parseDurationToMs,
  type EffectiveRateLimit,
} from "./RateLimitSection";

export type RateLimitDomain = {
  intent: string;
  systemDefault: () => RateLimiterConfig;
  apply: (
    orgId: string,
    next: RateLimitTokenBucketConfig,
    adminUserId: string
  ) => Promise<void>;
};

export function resolveEffectiveRateLimit(
  override: unknown,
  domain: RateLimitDomain
): EffectiveRateLimit {
  if (override == null) {
    return { source: "default", config: domain.systemDefault() };
  }
  const parsed = RateLimiterConfig.safeParse(override);
  if (parsed.success) {
    return { source: "override", config: parsed.data };
  }
  // Column holds malformed JSON — fall back silently. Admin must investigate
  // at the DB level; this UI can't recover it.
  return { source: "default", config: domain.systemDefault() };
}

export type RateLimitActionResult =
  | { ok: true }
  | { ok: false; errors: Record<string, string[] | undefined> };

export async function handleRateLimitAction(
  formData: FormData,
  orgId: string,
  adminUserId: string,
  domain: RateLimitDomain
): Promise<RateLimitActionResult> {
  const schema = z.object({
    intent: z.literal(domain.intent),
    refillRate: z.coerce.number().int().min(1),
    interval: z
      .string()
      .trim()
      .refine((v) => parseDurationToMs(v) > 0, {
        message: "Must be a duration like 10s, 1m, 500ms.",
      }),
    maxTokens: z.coerce.number().int().min(1),
  });

  const submission = schema.safeParse(Object.fromEntries(formData));
  if (!submission.success) {
    return { ok: false, errors: submission.error.flatten().fieldErrors };
  }

  const built = RateLimitTokenBucketConfig.safeParse({
    type: "tokenBucket",
    refillRate: submission.data.refillRate,
    interval: submission.data.interval,
    maxTokens: submission.data.maxTokens,
  });
  if (!built.success) {
    return { ok: false, errors: built.error.flatten().fieldErrors };
  }

  await domain.apply(orgId, built.data, adminUserId);
  return { ok: true };
}
