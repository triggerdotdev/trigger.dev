/** The health-recovery condition family. */

import type { WatchSpec } from "@internal/dashboard-agent-contracts";
import type {
  WatchCheckDeps,
  WatchCheckInput,
  WatchCheckOutcome,
} from "./dashboardAgentWatchCheckBase";

/**
 * Satisfied only when the health report is both trustworthy and `ok`. An untrustworthy
 * report can never fire a recovery.
 */
export async function checkHealthRecovery(
  spec: Extract<WatchSpec, { kind: "health_recovery" }>,
  deps: WatchCheckDeps,
  _input: WatchCheckInput
): Promise<WatchCheckOutcome> {
  const health = await deps.readHealth();
  if (!health) {
    return {
      result: "unavailable",
      facts: { report: spec.report, reason: "report_unavailable" },
      observed: { kind: "health_recovery", verified: false, severity: null },
    };
  }

  const facts = {
    report: spec.report,
    fromSeverity: spec.fromSeverity,
    severity: health.severity,
    trustworthy: health.trustworthy,
  };

  if (!health.trustworthy) {
    // An untrustworthy report is not an observation of the severity, so record none.
    return {
      result: "pending",
      facts: { ...facts, reason: "untrustworthy" },
      observed: { kind: "health_recovery", verified: false, severity: null },
    };
  }

  return {
    result: health.severity === "ok" ? "satisfied" : "pending",
    facts,
    observed: { kind: "health_recovery", verified: true, severity: health.severity },
  };
}
