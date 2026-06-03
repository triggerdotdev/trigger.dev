import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { type Duration } from "~/services/rateLimiter.server";
import { API_RATE_LIMIT_INTENT } from "./ApiRateLimitSection";
import {
  handleRateLimitAction,
  resolveEffectiveRateLimit,
  type RateLimitActionResult,
  type RateLimitDomain,
} from "./RateLimitSection.server";
import type { EffectiveRateLimit } from "./RateLimitSection";

export const apiRateLimitDomain: RateLimitDomain = {
  intent: API_RATE_LIMIT_INTENT,
  systemDefault: () => ({
    type: "tokenBucket",
    refillRate: env.API_RATE_LIMIT_REFILL_RATE,
    interval: env.API_RATE_LIMIT_REFILL_INTERVAL as Duration,
    maxTokens: env.API_RATE_LIMIT_MAX,
  }),
  apply: async (orgId, next, adminUserId) => {
    const existing = await prisma.organization.findFirst({
      where: { id: orgId },
      select: { apiRateLimiterConfig: true },
    });
    if (!existing) {
      throw new Response(null, { status: 404 });
    }
    await prisma.organization.update({
      where: { id: orgId },
      data: { apiRateLimiterConfig: next as any },
    });
    logger.info("admin.backOffice.apiRateLimit", {
      adminUserId,
      orgId,
      previous: existing.apiRateLimiterConfig,
      next,
    });
  },
};

export function resolveEffectiveApiRateLimit(
  override: unknown
): EffectiveRateLimit {
  return resolveEffectiveRateLimit(override, apiRateLimitDomain);
}

export function handleApiRateLimitAction(
  formData: FormData,
  orgId: string,
  adminUserId: string
): Promise<RateLimitActionResult> {
  return handleRateLimitAction(formData, orgId, adminUserId, apiRateLimitDomain);
}
