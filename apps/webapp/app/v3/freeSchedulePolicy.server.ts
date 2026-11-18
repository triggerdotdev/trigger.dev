import { metrics } from "@opentelemetry/api";
import { getCurrentPlan, isBillingConfigured } from "~/services/platform.v3.server";
import { ServiceValidationError } from "./services/baseService.server";
import { validateMinimumCronInterval } from "./validateMinimumCronInterval";

/** Unknown billing state does not allow clearing an existing restriction. */
export type FreeSchedulePlanState = "paying" | "non_paying" | "unknown" | "not_configured";

export class SchedulePlanLimitError extends ServiceValidationError {
  constructor(message: string) {
    super(message, 422, "warn");
    this.name = "SchedulePlanLimitError";
  }
}

const meter = metrics.getMeter("trigger.dev/free-schedule-policy");
const cronRejectionCounter = meter.createCounter("free_schedule_policy.cron_rejections_total", {
  description: "Cron expressions rejected for being more frequent than the free-plan minimum",
});

export async function resolvePlanState(organizationId: string): Promise<FreeSchedulePlanState> {
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

/** Only confirmed paying status clears a previously stored restriction. */
export function resolveMinimumWindowOnUpdate(
  planState: FreeSchedulePlanState,
  existingMinimumWindowDurationSeconds: number | null
): { minimumWindowDurationSeconds: number | null; enforce: boolean; cleared: boolean } {
  if (existingMinimumWindowDurationSeconds === null) {
    return { minimumWindowDurationSeconds: null, enforce: false, cleared: false };
  }

  if (planState === "paying") {
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

  const taskPrefix = taskIdentifier ? `Task \`${taskIdentifier}\`: ` : "";

  throw new SchedulePlanLimitError(
    `${taskPrefix}Free plan is limited to hourly schedules or less. ` +
      `Change the cron expression or upgrade before saving this schedule.`
  );
}
