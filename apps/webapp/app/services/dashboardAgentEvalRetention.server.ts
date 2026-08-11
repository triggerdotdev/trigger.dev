/**
 * Retention for the agent's judged-turn rows. The table is append-only quality data with
 * no reader, so it can't be left to grow forever; one bounded statement per run, oldest
 * first. Runs whether or not the agent is configured — rows outlive the agent project.
 */

import { deleteTurnEvalsOlderThan } from "@internal/dashboard-agent-db";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";
import { logger } from "~/services/logger.server";

/**
 * How long a judged turn is kept. Nothing reads the table today, and the rows carry the
 * user's question next to the agent's answer, so the period is the shortest one that still
 * lets a month of product review (capability and docs gaps) be aggregated.
 */
export const TURN_EVAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Per-run cap. Retention is one statement, not a row-at-a-time loop. */
const RETENTION_BATCH_LIMIT = 500;

export type TurnEvalRetentionResult = {
  /** Rows past the retention period dropped this run. */
  purged: number;
  failed: number;
};

export type TurnEvalRetentionDeps = {
  now?: () => Date;
  limit?: number;
  /** Drop rows created before `before`. Returns how many went. */
  purge?: (params: { before: Date; limit: number }) => Promise<number>;
};

export async function sweepDashboardAgentTurnEvals(
  deps: TurnEvalRetentionDeps = {}
): Promise<TurnEvalRetentionResult> {
  const now = deps.now?.() ?? new Date();
  const limit = deps.limit ?? RETENTION_BATCH_LIMIT;
  const purge = deps.purge ?? ((params) => deleteTurnEvalsOlderThan(dashboardAgentDb, params));

  const result: TurnEvalRetentionResult = { purged: 0, failed: 0 };

  try {
    result.purged = await purge({
      before: new Date(now.getTime() - TURN_EVAL_RETENTION_MS),
      limit,
    });
  } catch (error) {
    result.failed++;
    logger.error("Dashboard agent turn-eval retention failed", { error });
  }

  if (result.failed > 0) {
    throw new Error("The dashboard agent turn-eval retention pass failed");
  }

  return result;
}
