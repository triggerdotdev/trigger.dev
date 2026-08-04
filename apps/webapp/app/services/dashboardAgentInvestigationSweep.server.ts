/**
 * The investigation backstop — cards left `in_progress` between turns.
 *
 * A turn settles what it left open: the agent force-settles every card still
 * `in_progress` when the turn completes, so a spinner never outlives the answer.
 * Two rows escape that, and both are this sweep's job:
 *
 *  - a card whose turn died before its own settle ran, and
 *  - a card opened for a LATER turn to finish — a wake's narration does exactly
 *    this, since the wake turn holds no delegated token — whose follow-up never
 *    came.
 *
 * Both look the same from here and both read the same to the user: a card
 * spinning forever, and a chat marked "Investigating…" in History forever. So they
 * get the same ending the turn-level settle gives, `inconclusive` with the
 * facts that were established kept — never a cause, never a fix, and never a
 * claim that anything was proven.
 *
 * Guarded, not coordinated: the settle is one statement conditional on the row
 * still being `in_progress`, so a turn that concludes the card first wins and the
 * sweep no-ops.
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
 * How long a card may sit `in_progress` before the sweep settles it. A turn runs
 * for minutes and bumps `updated_at` on every revision, so this only has to
 * outlast the slowest live turn — it must never settle a card someone is writing.
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
 * Each row is handled on its own — a single failure must not cost the rest of the
 * batch — and the run throws at the end if anything failed, so the job is retried
 * and the failures are visible. A row left behind stays exactly as it was, and the
 * next sweep picks it up again.
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
