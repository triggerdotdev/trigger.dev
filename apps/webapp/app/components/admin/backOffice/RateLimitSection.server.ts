import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import {
  RateLimitTokenBucketConfig,
  RateLimiterConfig,
} from "~/services/authorizationRateLimitMiddleware.server";
import { logger } from "~/services/logger.server";
import { type Duration } from "~/services/rateLimiter.server";
import {
  parseDurationToMs,
  RATE_LIMIT_INTENT,
  type EffectiveRateLimit,
} from "./RateLimitSection";

function systemDefaultRateLimit() {
  return {
    type: "tokenBucket" as const,
    refillRate: env.API_RATE_LIMIT_REFILL_RATE,
    interval: env.API_RATE_LIMIT_REFILL_INTERVAL as Duration,
    maxTokens: env.API_RATE_LIMIT_MAX,
  };
}

export function resolveEffectiveRateLimit(
  override: unknown
): EffectiveRateLimit {
  if (override == null) {
    return { source: "default", config: systemDefaultRateLimit() };
  }
  const parsed = RateLimiterConfig.safeParse(override);
  if (parsed.success) {
    return { source: "override", config: parsed.data };
  }
  // Column holds malformed JSON — fall back silently. Admin must investigate
  // at the DB level; this UI can't recover it.
  return { source: "default", config: systemDefaultRateLimit() };
}

const SetRateLimitSchema = z.object({
  intent: z.literal(RATE_LIMIT_INTENT),
  refillRate: z.coerce.number().int().min(1),
  interval: z
    .string()
    .trim()
    .refine((v) => parseDurationToMs(v) > 0, {
      message: "Must be a duration like 10s, 1m, 500ms.",
    }),
  maxTokens: z.coerce.number().int().min(1),
});

export type RateLimitActionResult =
  | { ok: true }
  | { ok: false; errors: Record<string, string[] | undefined> };

export async function handleRateLimitAction(
  formData: FormData,
  orgId: string,
  adminUserId: string
): Promise<RateLimitActionResult> {
  const submission = SetRateLimitSchema.safeParse(Object.fromEntries(formData));
  if (!submission.success) {
    return { ok: false, errors: submission.error.flatten().fieldErrors };
  }

  const existing = await prisma.organization.findFirst({
    where: { id: orgId },
    select: { apiRateLimiterConfig: true },
  });
  if (!existing) {
    throw new Response(null, { status: 404 });
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

  await prisma.organization.update({
    where: { id: orgId },
    data: { apiRateLimiterConfig: built.data as any },
  });

  logger.info("admin.backOffice.rateLimit", {
    adminUserId,
    orgId,
    previous: existing.apiRateLimiterConfig,
    next: built.data,
  });

  return { ok: true };
}
