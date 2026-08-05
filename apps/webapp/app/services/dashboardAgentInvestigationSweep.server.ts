/**
 * The investigation backstop, for cards left `in_progress` between turns. A turn
 * force-settles what it left open, but two rows escape that: a card whose turn died
 * before its settle ran, and a card opened for a later turn whose follow-up never came.
 * Both read the same to the user, a card spinning forever, so both get the same ending
 * the turn-level settle gives: `inconclusive`, keeping the facts that were established
 * and claiming nothing that wasn't proven.
 *
 * Guarded, not coordinated: the settle is one statement conditional on the row still
 * being `in_progress`, so a turn that concludes the card first wins.
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
 * How long a card may sit `in_progress` before the sweep settles it. A turn bumps
 * `updated_at` on every revision, so this only has to outlast the slowest live turn. It
 * must never settle a card someone is writing.
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
 * One sweep: settle every card that has been `in_progress` past the grace window.
 *
 * Each row is handled on its own so a single failure doesn't cost the rest of the batch,
 * and the run throws at the end if anything failed, so the job is retried. A row left
 * behind stays as it was and the next sweep picks it up.
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
