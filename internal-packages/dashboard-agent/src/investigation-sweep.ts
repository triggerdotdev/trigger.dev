import { UNSETTLED_INVESTIGATION_NOTE } from "@internal/dashboard-agent-contracts";
import {
  listStaleOpenInvestigations,
  recordInvestigationSweepAttempt,
  settleInvestigationAndCloseCard,
  settleInvestigationAsInconclusive,
  type DashboardAgentDb,
  type Investigation,
  type SettledInvestigation,
  type SettledInvestigationCard,
} from "@internal/dashboard-agent-db";
import { logger, schedules } from "@trigger.dev/sdk";
import { serializeError } from "./serialize-error";
import { getWatchDb, watchConnectionString } from "./watch-task-adapters";

/**
 * The investigation backstop, for cards left `in_progress`. They settle as `inconclusive`,
 * conditional on the row still being `in_progress`, so a concluding turn wins the race.
 */

/**
 * How long a card may sit `in_progress` before the sweep settles it. Must outlast the
 * slowest live turn, which bumps `updated_at` on every revision.
 */
export const INVESTIGATION_STALE_MS = 30 * 60 * 1000;

/** Per-run cap. Oldest first, so the rest land next run. */
const SWEEP_BATCH_LIMIT = 100;

/**
 * After this many failed settle attempts a row is force-abandoned: settled `inconclusive`
 * WITHOUT the closing card, so a card that never renders leaves the queue instead of
 * looping forever. The rare stuck spinner is the price of not starving every other row.
 */
export const MAX_SWEEP_ATTEMPTS = 5;

export type InvestigationSweepResult = {
  /** Stale `in_progress` rows seen. */
  stale: number;
  settled: number;
  /** Settled rows whose closing card reached the chat. */
  closed: number;
  /** A turn (or another sweep) settled it first. */
  alreadySettled: number;
  /** Rows past the attempt cap, force-settled without a card so they leave the queue. */
  abandoned: number;
  failed: number;
};

export type InvestigationSweepDeps = {
  now?: () => Date;
  limit?: number;
  listStale?: (params: { olderThan: Date; limit: number }) => Promise<Investigation[]>;
  /**
   * Settle one row and deliver its closing card as a single operation. Null when the
   * row was no longer `in_progress`.
   */
  settleAndClose?: (params: {
    id: string;
    chatId: string;
    note: string;
  }) => Promise<SettledInvestigationCard | null>;
  /** Record a failed settle out-of-band; returns the new attempt count, or null if gone. */
  recordAttempt?: (params: { id: string }) => Promise<number | null>;
  /** Force a poison row terminal without the failing render path. */
  forceAbandon?: (params: { id: string; note: string }) => Promise<SettledInvestigation | null>;
};

/**
 * Settle every card `in_progress` past the grace window. Each row is handled on its own,
 * and the run throws at the end if any failed so the job is retried.
 */
export async function sweepDashboardAgentInvestigations(
  db: DashboardAgentDb,
  deps: InvestigationSweepDeps = {}
): Promise<InvestigationSweepResult> {
  const now = deps.now?.() ?? new Date();
  const limit = deps.limit ?? SWEEP_BATCH_LIMIT;
  const listStale = deps.listStale ?? ((params) => listStaleOpenInvestigations(db, params));
  const settleAndClose =
    deps.settleAndClose ?? ((params) => settleInvestigationAndCloseCard(db, params));
  const recordAttempt =
    deps.recordAttempt ?? ((params) => recordInvestigationSweepAttempt(db, params));
  const forceAbandon =
    deps.forceAbandon ?? ((params) => settleInvestigationAsInconclusive(db, params));

  const result: InvestigationSweepResult = {
    stale: 0,
    settled: 0,
    closed: 0,
    alreadySettled: 0,
    abandoned: 0,
    failed: 0,
  };

  const stale = await listStale({
    olderThan: new Date(now.getTime() - INVESTIGATION_STALE_MS),
    limit,
  });
  result.stale = stale.length;

  for (const investigation of stale) {
    try {
      // Settling the row fixes nothing on its own: the chat renders the winning card
      // from its own transcript, so an unappended settle is still a stuck spinner —
      // which is why both writes are one operation that rolls back together.
      const outcome = await settleAndClose({
        id: investigation.id,
        chatId: investigation.chatId,
        note: UNSETTLED_INVESTIGATION_NOTE,
      });
      if (!outcome) {
        result.alreadySettled++;
        continue;
      }
      result.settled++;
      if (outcome.closed) result.closed++;
    } catch (error) {
      // The settle rolled back, so the row is still `in_progress`. Record the attempt in
      // its own write — this rotates the row to the back of the sweep order (see
      // `listStaleOpenInvestigations`) so it can't pin the head and starve newer rows.
      let attempts: number | null = null;
      try {
        attempts = await recordAttempt({ id: investigation.id });
      } catch (recordError) {
        logger.error("dashboard-agent investigation sweep: failed to record a sweep attempt", {
          investigationId: investigation.id,
          chatId: investigation.chatId,
          error: serializeError(recordError),
        });
      }

      // Past the cap the card will never render; force it terminal without the render
      // path so it leaves the queue instead of looping forever.
      if (attempts !== null && attempts >= MAX_SWEEP_ATTEMPTS) {
        try {
          await forceAbandon({ id: investigation.id, note: UNSETTLED_INVESTIGATION_NOTE });
          result.abandoned++;
          logger.warn(
            "dashboard-agent investigation sweep: abandoned a card past the attempt cap",
            {
              investigationId: investigation.id,
              chatId: investigation.chatId,
              attempts,
            }
          );
          continue;
        } catch (abandonError) {
          logger.error("dashboard-agent investigation sweep: failed to abandon a poison card", {
            investigationId: investigation.id,
            chatId: investigation.chatId,
            error: serializeError(abandonError),
          });
        }
      }

      result.failed++;
      logger.error("dashboard-agent investigation sweep: failed to settle an investigation", {
        investigationId: investigation.id,
        chatId: investigation.chatId,
        attempts,
        error: serializeError(error),
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

const EMPTY_SWEEP_RESULT: InvestigationSweepResult = {
  stale: 0,
  settled: 0,
  closed: 0,
  alreadySettled: 0,
  abandoned: 0,
  failed: 0,
};

const dashboardAgentInvestigationSweep = schedules.task({
  id: "dashboard-agent-investigation-sweep",
  cron: "*/5 * * * *",
  retry: { maxAttempts: 3 },
  run: async (): Promise<InvestigationSweepResult> => {
    if (!watchConnectionString()) {
      logger.warn(
        "dashboard-agent investigation sweep skipped: no DASHBOARD_AGENT_DATABASE_URL or DATABASE_URL"
      );
      return { ...EMPTY_SWEEP_RESULT };
    }

    const { db } = getWatchDb();
    const result = await sweepDashboardAgentInvestigations(db);

    logger.info("dashboard-agent investigations swept", result);

    return result;
  },
});
