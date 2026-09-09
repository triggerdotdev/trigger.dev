import { metrics } from "@opentelemetry/api";
import { flag } from "~/v3/featureFlags.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { getCurrentPlan, isBillingConfigured } from "~/services/platform.v3.server";
import { ServiceValidationError } from "./services/baseService.server";
import {
  FREE_SCHEDULE_MINIMUM_WINDOW_SECONDS,
  validateMinimumCronInterval,
} from "./validateMinimumCronInterval";

/** Unknown billing state allows neither enrollment nor clearing an existing restriction. */
type FreeSchedulePlanState = "paying" | "non_paying" | "unknown" | "not_configured";

export type FreeSchedulePolicyContext = {
  /** Gates new-schedule enrollment only. */
  flagEnabled: boolean;
  planState: FreeSchedulePlanState;
};

const meter = metrics.getMeter("trigger.dev/free-schedule-policy");
const createDecisionCounter = meter.createCounter("free_schedule_policy.create_decisions_total", {
  description: "New-schedule enrollment decisions for the free-plan minimum-window policy",
});
const cronRejectionCounter = meter.createCounter("free_schedule_policy.cron_rejections_total", {
  description: "Cron expressions rejected for being more frequent than the free-plan minimum",
});

/** Resolve once per request or sync: getCurrentPlan is an uncached remote call. */
export async function resolveFreeSchedulePolicyContext(organization: {
  id: string;
  featureFlags: unknown;
}): Promise<FreeSchedulePolicyContext> {
  const overrides =
    organization.featureFlags &&
    typeof organization.featureFlags === "object" &&
    !Array.isArray(organization.featureFlags)
      ? (organization.featureFlags as Record<string, unknown>)
      : undefined;

  const flagEnabled = await flag({
    key: FEATURE_FLAG.freeScheduleMinimumWindowEnabled,
    defaultValue: false,
    overrides,
  });

  return {
    flagEnabled,
    planState: await resolvePlanState(organization.id),
  };
}

async function resolvePlanState(organizationId: string): Promise<FreeSchedulePlanState> {
  if (!isBillingConfigured()) {
    return "not_configured";
  }

  const plan = await getCurrentPlan(organizationId);
  if (!plan) {
    return "unknown";
  }

  const isPaying = plan.v3Subscription?.isPaying;
  if (isPaying === true) return "paying";
  if (isPaying === false) return "non_paying";
  return "unknown";
}

/** A non-null result also requires {@link assertCronMeetsFreeMinimum} before saving. */
export function minimumWindowForNewSchedule(
  context: FreeSchedulePolicyContext,
  scheduleType: "IMPERATIVE" | "DECLARATIVE"
): number | null {
  const shouldRestrict = context.flagEnabled && context.planState === "non_paying";
  const restricted = shouldRestrict ? FREE_SCHEDULE_MINIMUM_WINDOW_SECONDS : null;

  createDecisionCounter.add(1, {
    decision: shouldRestrict
      ? "restricted"
      : !context.flagEnabled
        ? "flag_disabled"
        : context.planState,
    schedule_type: scheduleType,
  });

  return restricted;
}

/** Updates never enroll; only confirmed paying status clears a restriction, regardless of the flag. */
export function resolveMinimumWindowOnUpdate(
  context: Pick<FreeSchedulePolicyContext, "planState">,
  existingMinimumWindowDurationSeconds: number | null
): { minimumWindowDurationSeconds: number | null; enforce: boolean; cleared: boolean } {
  if (existingMinimumWindowDurationSeconds === null) {
    return { minimumWindowDurationSeconds: null, enforce: false, cleared: false };
  }

  if (context.planState === "paying") {
    return { minimumWindowDurationSeconds: null, enforce: false, cleared: true };
  }

  return {
    minimumWindowDurationSeconds: existingMinimumWindowDurationSeconds,
    enforce: true,
    cleared: false,
  };
}

/** Report minimum-interval violations as policy limits, not invalid cron syntax. */
export function assertCronMeetsFreeMinimum({
  cron,
  timezone,
  minimumWindowDurationSeconds,
  scheduleType,
  environmentType,
  taskIdentifier,
}: {
  cron: string;
  timezone?: string | null;
  minimumWindowDurationSeconds: number;
  scheduleType: "IMPERATIVE" | "DECLARATIVE";
  environmentType?: string;
  taskIdentifier?: string;
}): void {
  const result = validateMinimumCronInterval({
    cron,
    timezone,
    minimumMs: minimumWindowDurationSeconds * 1_000,
  });

  if (result.valid) {
    return;
  }

  cronRejectionCounter.add(1, {
    schedule_type: scheduleType,
    // Low-cardinality labels only — never org/task ids.
    environment_type: environmentType ?? "unknown",
  });

  const minutes = Math.round(minimumWindowDurationSeconds / 60);
  const taskPrefix = taskIdentifier ? `Schedule for task \`${taskIdentifier}\`: ` : "";

  throw new ServiceValidationError(
    `${taskPrefix}Free-plan schedules must have at least ${minutes} minutes between runs. ` +
      `Change the cron expression or upgrade before saving this schedule.`
  );
}
