import { tryCatch } from "@trigger.dev/core";
import { prisma, type PrismaClientOrTransaction } from "~/db.server";
import { env } from "~/env.server";
import { type CardVerification } from "~/services/cardVerification.schemas";
import { logger } from "~/services/logger.server";
import {
  getCardVerification,
  getCurrentPlan,
  isBillingConfigured,
} from "~/services/platform.v3.server";
import { getDeploymentAccessController } from "./deploymentAccess.server";

export type CardVerificationGateConfig = { enabled: boolean; requiredFrom: Date | undefined };

/** "unknown": billing couldn't say. Callers choose: the banner stays hidden, a deploy refusal may fail closed. */
export type CardVerificationGate = "gated" | "not_gated" | "unknown";

/** Billing's plan type, "not_configured" without billing, undefined when billing can't be read. */
export type GatePlanType = "free" | "paid" | "enterprise" | "not_configured" | undefined;

export function cardVerificationGateConfig(): CardVerificationGateConfig {
  return {
    enabled: env.CARD_VERIFICATION_GATE_ENABLED,
    requiredFrom: env.CARD_VERIFICATION_REQUIRED_FROM
      ? new Date(env.CARD_VERIFICATION_REQUIRED_FROM)
      : undefined,
  };
}

/** Switch on, and created at or after the cutoff (any org when the cutoff is unset). */
export function isInCardVerificationCohort(
  config: CardVerificationGateConfig,
  organizationCreatedAt: Date
): boolean {
  if (!config.enabled) return false;
  if (!config.requiredFrom) return true;
  return organizationCreatedAt >= config.requiredFrom;
}

/**
 * Pure decision. Only Free orgs in the cohort are gated, and only while billing says it can
 * verify their card (supported: false means no Metronome contract, so a missed backfill never
 * locks an org out) and no card is verified yet.
 */
export function decideCardVerificationGate({
  config,
  organizationCreatedAt,
  planType,
  verification,
}: {
  config: CardVerificationGateConfig;
  organizationCreatedAt: Date;
  planType: GatePlanType;
  verification: CardVerification | null | undefined;
}): CardVerificationGate {
  if (!isInCardVerificationCohort(config, organizationCreatedAt)) return "not_gated";
  if (planType === undefined) return "unknown";
  if (planType !== "free") return "not_gated";
  if (!verification) return "unknown";
  if (!verification.supported || verification.verified) return "not_gated";
  return "gated";
}

export type CardVerificationGateDependencies = {
  client?: PrismaClientOrTransaction;
  config?: CardVerificationGateConfig;
  /** Pass when the caller already read the plan, to skip a second billing call. */
  planType?: (organizationId: string) => Promise<GatePlanType>;
  cardVerification?: (organizationId: string) => Promise<CardVerification | null>;
  /** Whether the org has an unexpired deploy access override. */
  hasActiveOverride?: (organizationId: string) => Promise<boolean>;
};

/**
 * The deployment access plugin owns the overrides. An org with one is governed by it, not by the
 * card gate. Without the plugin (OSS) no org has one.
 */
export async function hasActiveDeployAccessOverride(
  organizationId: string,
  controller = getDeploymentAccessController
): Promise<boolean> {
  const access = await controller();
  if (!access?.hasActiveOverride) return false;
  return access.hasActiveOverride(organizationId);
}

/** Maps a plan the caller already read, so the banner and the deploy refusal agree. */
export function gatePlanTypeFromPlan(
  plan: Awaited<ReturnType<typeof getCurrentPlan>>
): GatePlanType {
  if (!isBillingConfigured()) return "not_configured";
  return plan?.v3Subscription?.plan?.type;
}

export async function readGatePlanType(organizationId: string): Promise<GatePlanType> {
  if (!isBillingConfigured()) return "not_configured";
  return gatePlanTypeFromPlan(await getCurrentPlan(organizationId));
}

/**
 * Whether the org's cloud deploys are switched off until it verifies a card. Billing is read
 * only for orgs in the cohort; the override and the card only for Free orgs. An org with an
 * unexpired deploy access override is never gated: the override decides its deploys.
 */
export async function resolveCardVerificationGate(
  organizationId: string,
  {
    client = prisma,
    config = cardVerificationGateConfig(),
    planType = readGatePlanType,
    cardVerification = getCardVerification,
    hasActiveOverride = hasActiveDeployAccessOverride,
  }: CardVerificationGateDependencies = {}
): Promise<CardVerificationGate> {
  if (!config.enabled) return "not_gated";

  const [organizationError, organization] = await tryCatch(
    client.organization.findFirst({
      where: { id: organizationId },
      select: { createdAt: true },
    })
  );
  if (organizationError) {
    logger.error("Card verification gate could not read the organization", {
      organizationId,
      error: organizationError.message,
    });
    return "unknown";
  }
  if (!organization) return "not_gated";
  if (!isInCardVerificationCohort(config, organization.createdAt)) return "not_gated";

  const [planError, type] = await tryCatch(planType(organizationId));
  if (planError || type === undefined) return "unknown";
  if (type !== "free") return "not_gated";

  const [overrideError, overridden] = await tryCatch(hasActiveOverride(organizationId));
  if (overrideError) {
    logger.error("Card verification gate could not read the deploy access override", {
      organizationId,
      error: overrideError.message,
    });
    return "unknown";
  }
  if (overridden) return "not_gated";

  const [cardError, verification] = await tryCatch(cardVerification(organizationId));
  return decideCardVerificationGate({
    config,
    organizationCreatedAt: organization.createdAt,
    planType: type,
    verification: cardError ? null : verification,
  });
}
