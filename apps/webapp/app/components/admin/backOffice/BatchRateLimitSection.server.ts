import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { type Duration } from "~/services/rateLimiter.server";
import { BATCH_RATE_LIMIT_INTENT } from "./BatchRateLimitSection";
import {
  handleRateLimitAction,
  resolveEffectiveRateLimit,
  type RateLimitActionResult,
  type RateLimitDomain,
} from "./RateLimitSection.server";
import type { EffectiveRateLimit } from "./RateLimitSection";

export const batchRateLimitDomain: RateLimitDomain = {
  intent: BATCH_RATE_LIMIT_INTENT,
  systemDefault: () => ({
    type: "tokenBucket",
    refillRate: env.BATCH_RATE_LIMIT_REFILL_RATE,
    interval: env.BATCH_RATE_LIMIT_REFILL_INTERVAL as Duration,
    maxTokens: env.BATCH_RATE_LIMIT_MAX,
  }),
  apply: async (orgId, next, adminUserId) => {
    const existing = await prisma.organization.findFirst({
      where: { id: orgId },
      select: { batchRateLimitConfig: true },
    });
    if (!existing) {
      throw new Response(null, { status: 404 });
    }
    await prisma.organization.update({
      where: { id: orgId },
      data: { batchRateLimitConfig: next as any },
    });
    logger.info("admin.backOffice.batchRateLimit", {
      adminUserId,
      orgId,
      previous: existing.batchRateLimitConfig,
      next,
    });
  },
};

export function resolveEffectiveBatchRateLimit(
  override: unknown
): EffectiveRateLimit {
  return resolveEffectiveRateLimit(override, batchRateLimitDomain);
}

export function handleBatchRateLimitAction(
  formData: FormData,
  orgId: string,
  adminUserId: string
): Promise<RateLimitActionResult> {
  return handleRateLimitAction(formData, orgId, adminUserId, batchRateLimitDomain);
}
