/**
 * Execution analyzer: are the runs that do start completing OK? Failures and durations only. Its
 * "read:" line answers whether the flow problem is a code problem.
 */

import { isOk, maxSeverity, type Finding, type Metric } from "../report-view-model";
import { HEALTH_THRESHOLDS, metricById, type HealthInput } from "./health-core";

export const EXECUTION_METRIC_IDS = ["failures", "dur_p95"];

export function interpretExecution(metrics: Metric[], input: HealthInput): Finding {
  const exec = EXECUTION_METRIC_IDS.map((id) => metricById(metrics, id));
  const severity = maxSeverity(...exec.map((m) => m.severity));
  const failures = metricById(metrics, "failures");

  if (isOk(severity)) {
    return { type: "execution", severity, reason: "healthy", metricIds: EXECUTION_METRIC_IDS };
  }

  const reason = !isOk(failures.severity) ? "failures_up" : "slow_runs";
  const recommendation =
    reason === "failures_up"
      ? { code: "review_failing_tasks", link: "runs_failed" }
      : { code: "review_slow_runs", link: "runs" };

  // Lazy attribution when it owns >= minShare of failures.
  let attribution: Finding["attribution"];
  const fb = input.failureBreakdown;
  if (fb && fb.share >= HEALTH_THRESHOLDS.attribution.minShare) {
    attribution = { dim: "task", key: fb.task, share: fb.share, of: "failures" };
  }

  return {
    type: "execution",
    severity,
    reason,
    metricIds: EXECUTION_METRIC_IDS,
    recommendation,
    attribution,
  };
}

/**
 * Flow causes that provably can't be user code, so a healthy execution reads as not a code problem.
 * Trigger spike and surge are excluded because a code path fanning out task.trigger can be the
 * cause, and only the runs that execute may be called fine.
 */
const NOT_A_CODE_PROBLEM_CAUSES = new Set(["dequeue_stall"]);

export function buildExecutionRead(execution: Finding, flow: Finding): string {
  if (execution.reason === "unknown") return "data_stale";
  if (isOk(execution.severity)) {
    return NOT_A_CODE_PROBLEM_CAUSES.has(flow.reason) ? "not_a_code_problem" : "runs_are_fine";
  }
  return "failures_elevated";
}
