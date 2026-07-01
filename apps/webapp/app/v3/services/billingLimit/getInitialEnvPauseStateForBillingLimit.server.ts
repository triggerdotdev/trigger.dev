import { EnvironmentPauseSource,type Organization,type Project,type RuntimeEnvironment,type RuntimeEnvironmentType } from "@trigger.dev/database";
import type { BillingLimitResult } from "~/services/billingLimit.schemas";
import { logger } from "~/services/logger.server";
import { isBillableEnvironmentType } from "./billingLimitConstants";
import { resolveConvergeTargetFromBillingLimit } from "./billingLimitReconciliation.server";

export type InitialEnvPauseState = {
  paused: boolean;
  pauseSource: typeof EnvironmentPauseSource.BILLING_LIMIT | null;
};

export type GetInitialEnvPauseStateDeps = {
  getBillingLimit?: (organizationId: string) => Promise<BillingLimitResult | undefined>;
};

export async function getInitialEnvPauseStateForBillingLimit(
  organizationId: string,
  type: RuntimeEnvironmentType,
  deps: GetInitialEnvPauseStateDeps = {}
): Promise<InitialEnvPauseState> {
  if (!isBillableEnvironmentType(type)) {
    return { paused: false, pauseSource: null };
  }

  let billingLimit: BillingLimitResult | undefined;
  try {
    billingLimit = deps.getBillingLimit
      ? await deps.getBillingLimit(organizationId)
      : await (await import("~/services/platform.v3.server")).getBillingLimit(organizationId);
  } catch (error) {
    logger.error("Failed to fetch billing limit for initial env pause state", {
      organizationId,
      error,
    });
    return { paused: false, pauseSource: null };
  }

  const targetState = resolveConvergeTargetFromBillingLimit(billingLimit);

  if (targetState === "grace" || targetState === "rejected") {
    return {
      paused: true,
      pauseSource: EnvironmentPauseSource.BILLING_LIMIT,
    };
  }

  return { paused: false, pauseSource: null };
}

export async function applyBillingLimitPauseAfterEnvCreate(
  environment: RuntimeEnvironment & { organization: Organization; project: Project }
): Promise<void> {
  if (!environment.paused || environment.pauseSource !== EnvironmentPauseSource.BILLING_LIMIT) {
    return;
  }

  try {
    // Imported dynamically so this module (pulled in at module load by
    // upsertBranch.server.ts) doesn't eagerly load runQueue.server -> marqs ->
    // triggerTaskV1 -> the autoIncrementCounter singleton, which throws when
    // REDIS_HOST/REDIS_PORT are unset (e.g. the webapp unit-test CI job).
    const { updateEnvConcurrencyLimits } = await import("~/v3/runQueue.server");
    await updateEnvConcurrencyLimits(environment, 0);
  } catch (error) {
    logger.error("Failed to apply billing-limit pause after env create", {
      environmentId: environment.id,
      organizationId: environment.organizationId,
      error,
    });
  }
}
