import { BillingClient } from "@trigger.dev/platform";
import { z } from "zod";

/**
 * Billing limit API schemas for the billing platform service.
 *
 * These mirror the planned @trigger.dev/platform types and are used via
 * BillingClient.fetch until the platform package is published with native
 * BillingClient methods.
 */

export const BillingLimitStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
  }),
  z.object({
    status: z.literal("grace"),
    hitAt: z.string().datetime({ offset: true }),
    graceEndsAt: z.string().datetime({ offset: true }),
  }),
  z.object({
    status: z.literal("rejected"),
    hitAt: z.string().datetime({ offset: true }),
    graceEndsAt: z.string().datetime({ offset: true }),
  }),
]);

export type BillingLimitState = z.infer<typeof BillingLimitStateSchema>;

export const BillingLimitConfigSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("none"),
  }),
  z.object({
    mode: z.literal("plan"),
  }),
  z.object({
    mode: z.literal("custom"),
    amountCents: z.number().int().positive(),
  }),
]);

export type BillingLimitConfig = z.infer<typeof BillingLimitConfigSchema>;

export const BillingLimitUnconfiguredSchema = z.object({
  isConfigured: z.literal(false),
  gracePeriodMs: z.number().int().nonnegative(),
});

const billingLimitConfiguredFields = {
  isConfigured: z.literal(true),
  cancelInProgressRuns: z.boolean(),
  limitState: BillingLimitStateSchema,
  effectiveAmountCents: z.number().int().nonnegative().nullable(),
  gracePeriodMs: z.number().int().nonnegative(),
};

export const BillingLimitConfiguredNoneSchema = z.object({
  ...billingLimitConfiguredFields,
  mode: z.literal("none"),
});

export const BillingLimitConfiguredPlanSchema = z.object({
  ...billingLimitConfiguredFields,
  mode: z.literal("plan"),
});

export const BillingLimitConfiguredCustomSchema = z.object({
  ...billingLimitConfiguredFields,
  mode: z.literal("custom"),
  amountCents: z.number().int().positive(),
});

export const BillingLimitConfiguredSchema = z.discriminatedUnion("mode", [
  BillingLimitConfiguredNoneSchema,
  BillingLimitConfiguredPlanSchema,
  BillingLimitConfiguredCustomSchema,
]);

export const BillingLimitResultSchema = z.union([
  BillingLimitUnconfiguredSchema,
  BillingLimitConfiguredNoneSchema,
  BillingLimitConfiguredPlanSchema,
  BillingLimitConfiguredCustomSchema,
]);

export type BillingLimitResult = z.infer<typeof BillingLimitResultSchema>;

export const UpdateBillingLimitRequestSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("none"),
    cancelInProgressRuns: z.boolean(),
  }),
  z.object({
    mode: z.literal("plan"),
    cancelInProgressRuns: z.boolean(),
  }),
  z.object({
    mode: z.literal("custom"),
    amountCents: z.number().int().positive(),
    cancelInProgressRuns: z.boolean(),
  }),
]);

export type UpdateBillingLimitRequest = z.infer<typeof UpdateBillingLimitRequestSchema>;

export const ResolveBillingLimitRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("increase"),
    newAmountCents: z.number().int().positive(),
    resumeMode: z.enum(["queue", "new_only"]),
  }),
  z.object({
    action: z.literal("remove"),
    resumeMode: z.enum(["queue", "new_only"]),
  }),
]);

export type ResolveBillingLimitRequest = z.infer<typeof ResolveBillingLimitRequestSchema>;

export const BillingLimitActiveOrgSchema = z.object({
  orgId: z.string(),
  limitState: z.enum(["grace", "rejected"]),
});

export const BillingLimitsActiveResultSchema = z.object({
  orgs: z.array(BillingLimitActiveOrgSchema),
});

export type BillingLimitsActiveResult = z.infer<typeof BillingLimitsActiveResultSchema>;

export const BillingLimitPendingResolveOrgSchema = z.object({
  organizationId: z.string(),
  resumeMode: z.enum(["queue", "new_only"]),
  resolvedAt: z.string().datetime({ offset: true }),
});

export const BillingLimitsPendingResolvesResultSchema = z.object({
  orgs: z.array(BillingLimitPendingResolveOrgSchema),
});

export type BillingLimitsPendingResolvesResult = z.infer<
  typeof BillingLimitsPendingResolvesResultSchema
>;

export const BillingLimitHitWebhookBodySchema = z.object({
  hitAt: z.string().datetime({ offset: true }),
  cancelInProgressRuns: z.boolean(),
  limitState: z.literal("grace"),
});

export type BillingLimitHitWebhookBody = z.infer<typeof BillingLimitHitWebhookBodySchema>;

/** Entitlement response — mirrors ReportUsageResult with billing limit fields until platform ships native types. */
export const EntitlementResultSchema = z.object({
  hasAccess: z.boolean(),
  balance: z.number().optional(),
  usage: z.number().optional(),
  overage: z.number().optional(),
  plan: z
    .object({
      type: z.string(),
      code: z.string(),
      isPaying: z.boolean(),
    })
    .optional(),
  limitState: z.literal("grace").optional(),
  reason: z.enum(["free_tier_exceeded", "billing_limit"]).optional(),
});

export type EntitlementResult = z.infer<typeof EntitlementResultSchema>;

export type BillingLimitPageData = BillingLimitResult & {
  queuedRunCount: number;
  currentSpendCents: number;
};

/** Bridge webapp Zod schemas to BillingClient.fetch (separate Zod type instances). */
export function asPlatformSchema(schema: z.ZodTypeAny) {
  return schema as unknown as Parameters<BillingClient["fetch"]>[1];
}
