/**
 * The investigation backstop, for cards left `in_progress`. They settle as `inconclusive`,
 * conditional on the row still being `in_progress`, so a concluding turn wins the race.
 */

import {
  listStaleOpenInvestigations,
  settleInvestigationAsInconclusive,
  type Investigation,
} from "@internal/dashboard-agent-db";
import { UNSETTLED_INVESTIGATION_NOTE } from "@internal/dashboard-agent-contracts";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";
import { logger } from "~/services/logger.server";

/**
 * How long a card may sit `in_progress` before the sweep settles it. Must outlast the
 * slowest live turn, which bumps `updated_at` on every revision.
 */
export const INVESTIGATION_STALE_MS = 30 * 60 * 1000;

/** Per-run cap. Oldest first, so the rest land next run. */
const SWEEP_BATCH_LIMIT = 100;

export type InvestigationSweepResult = {
  /** Stale `in_progress` rows seen. */
  stale: number;
  settled: number;
  /** A turn (or another sweep) settled it first. */
  alreadySettled: number;
  failed: number;
};

export type InvestigationSweepDeps = {
  now?: () => Date;
  limit?: number;
  listStale?: (params: { olderThan: Date; limit: number }) => Promise<Investigation[]>;
  /** Settle one row. False when it was no longer `in_progress`. */
  settle?: (params: { id: string; note: string }) => Promise<boolean>;
};

/**
 * Settle every card `in_progress` past the grace window. Each row is handled on its own,
 * and the run throws at the end if any failed so the job is retried.
 */
export async function sweepDashboardAgentInvestigations(
  deps: InvestigationSweepDeps = {}
): Promise<InvestigationSweepResult> {
  const now = deps.now?.() ?? new Date();
  const limit = deps.limit ?? SWEEP_BATCH_LIMIT;
  const listStale =
    deps.listStale ?? ((params) => listStaleOpenInvestigations(dashboardAgentDb, params));
  const settle =
    deps.settle ?? ((params) => settleInvestigationAsInconclusive(dashboardAgentDb, params));

  const result: InvestigationSweepResult = {
    stale: 0,
    settled: 0,
    alreadySettled: 0,
    failed: 0,
  };

  const stale = await listStale({
    olderThan: new Date(now.getTime() - INVESTIGATION_STALE_MS),
    limit,
  });
  result.stale = stale.length;

  for (const investigation of stale) {
    try {
      const settled = await settle({ id: investigation.id, note: UNSETTLED_INVESTIGATION_NOTE });
      if (settled) result.settled++;
      else result.alreadySettled++;
    } catch (error) {
      result.failed++;
      logger.error("Dashboard agent investigation sweep: failed to settle an investigation", {
        investigationId: investigation.id,
        chatId: investigation.chatId,
        error,
      });
    }
  }

  if (result.failed > 0) {
    throw new Error(
      `The dashboard agent investigation sweep failed on ${result.failed} investigations`
    );
  }

  return result;
}
