import { type Alert, claimAlertForEvaluation, getAlert } from "../storage/alertStore.server";
import {
  evaluateAlert,
  releaseLeaseToNextCadence,
  type EvaluateAlertDeps,
} from "./evaluateAlert.server";

const UNSCHEDULED_RETRY_MS = 5_000;
export const EVALUATION_LEASE_GRACE_MS = 60_000;

type ScheduleState = Pick<Alert, "lifecycle" | "nextEvaluationAt" | "evaluationLeaseUntil">;

type EvaluateJobOptions = {
  id: string;
  job: "alerts.evaluate";
  payload: { alertId: string };
  availableAt: Date;
};

type AlertEvaluationWorker = {
  enqueue(options: EvaluateJobOptions): Promise<unknown>;
  enqueueOnce(options: EvaluateJobOptions): Promise<boolean>;
  ack(id: string): Promise<unknown>;
};

export function alertEvaluationJobId(alertId: string) {
  return `alert-eval:${alertId}`;
}

export function alertEvaluationJobs(worker: AlertEvaluationWorker) {
  const options = (alertId: string, availableAt: Date): EvaluateJobOptions => ({
    id: alertEvaluationJobId(alertId),
    job: "alerts.evaluate",
    payload: { alertId },
    availableAt,
  });
  return {
    enqueue: (alertId: string, availableAt: Date) => worker.enqueue(options(alertId, availableAt)),
    enqueueOnce: (alertId: string, availableAt: Date) =>
      worker.enqueueOnce(options(alertId, availableAt)),
    ack: (alertId: string) => worker.ack(alertEvaluationJobId(alertId)),
  };
}

export interface EvaluateAlertJobDeps extends EvaluateAlertDeps {
  leaseMs: number;
  enqueue: (alertId: string, availableAt: Date) => Promise<unknown>;
  isOrganizationEnabled: (organizationId: string) => Promise<boolean>;
}

export async function runEvaluateAlertJob(
  params: { alertId: string; now: Date },
  deps: EvaluateAlertJobDeps
): Promise<{ nextAt: Date | null }> {
  const { alertId, now } = params;
  const claim = await claimAlertForEvaluation(deps.db, { id: alertId, now, leaseMs: deps.leaseMs });

  let alert: ScheduleState | null;
  if (claim.claimed) {
    const { organizationId } = claim.alert;
    if (!(await deps.isOrganizationEnabled(organizationId))) {
      deps.logger?.debug("alerts.evaluate.org_disabled", { organizationId, alertId });
      await releaseLeaseToNextCadence(claim.alert, deps);
      alert = await getAlert(deps.db, { id: alertId });
    } else {
      const result = await evaluateAlert(claim.alert, deps);
      alert = result.alert ?? (await getAlert(deps.db, { id: alertId }));
    }
    if (alert?.lifecycle !== "active") return { nextAt: null };
  } else if (claim.reason === "not_due" || claim.reason === "leased") {
    alert = claim.alert ?? null;
  } else {
    return { nextAt: null };
  }

  const nextAt = nextRunAt(alert, now);
  await deps.enqueue(alertId, nextAt);
  return { nextAt };
}

export function nextRunAt(
  alert: Pick<Alert, "nextEvaluationAt" | "evaluationLeaseUntil"> | null,
  now: Date
): Date {
  const due = alert?.nextEvaluationAt?.getTime();
  const leaseUntil = alert?.evaluationLeaseUntil?.getTime();
  if (due === undefined && leaseUntil === undefined) {
    return new Date(now.getTime() + UNSCHEDULED_RETRY_MS);
  }
  return new Date(Math.max(due ?? now.getTime(), leaseUntil ?? now.getTime()));
}
