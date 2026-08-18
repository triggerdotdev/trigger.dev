import {
  deleteTerminalWatchesOlderThan,
  deleteTurnEvalsOlderThan,
  deleteWatchSubmissionsOlderThan,
  hardDeleteChatsSoftDeletedBefore,
  type DashboardAgentDb,
} from "@internal/dashboard-agent-db";
import { logger } from "@trigger.dev/sdk";
import { serializeError } from "./serialize-error";

/**
 * Retention for the agent's own datastore: judged turns, soft-deleted chats, and the
 * finished watch rows. One daily pass, oldest first, bounded per statement.
 */

/**
 * How long a judged turn is kept. Nothing reads the table today, and the rows carry the
 * user's question next to the agent's answer, so the period is the shortest one that still
 * lets a month of product review be aggregated.
 */
export const TURN_EVAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long a soft-deleted chat is kept before it and its children are hard-deleted. Long
 * enough that an accidental delete can still be investigated; organization deletion soft-
 * deletes the org's chats, so those are removed the same way once the window passes.
 */
const CHAT_SOFT_DELETE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** How long a terminal watch and its submission ledger are kept. */
const WATCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Per-statement cap. */
const RETENTION_BATCH_LIMIT = 500;

/** Cap on the statements one pass may run, so a huge backlog can't run forever. */
const MAX_RETENTION_BATCHES = 200;

export type RetentionResult = {
  turnEvals: number;
  chats: number;
  watches: number;
  watchSubmissions: number;
};

type Purge = (params: { before: Date; limit: number }) => Promise<number>;

export type RetentionDeps = {
  now?: () => Date;
  limit?: number;
  maxBatches?: number;
  purgeTurnEvals?: Purge;
  purgeChats?: Purge;
  purgeWatches?: Purge;
  purgeWatchSubmissions?: Purge;
};

/**
 * Runs every retention pass. Each is bounded and independent: a failing one is reported at
 * the end so it can't mask the others, and the throw retries the run.
 */
export async function runDashboardAgentRetention(
  db: DashboardAgentDb,
  deps: RetentionDeps = {}
): Promise<RetentionResult> {
  const now = deps.now?.() ?? new Date();
  const limit = deps.limit ?? RETENTION_BATCH_LIMIT;
  const maxBatches = deps.maxBatches ?? MAX_RETENTION_BATCHES;

  const purgeTurnEvals = deps.purgeTurnEvals ?? ((params) => deleteTurnEvalsOlderThan(db, params));
  const purgeChats = deps.purgeChats ?? ((params) => hardDeleteChatsSoftDeletedBefore(db, params));
  const purgeWatches =
    deps.purgeWatches ?? ((params) => deleteTerminalWatchesOlderThan(db, params));
  const purgeWatchSubmissions =
    deps.purgeWatchSubmissions ?? ((params) => deleteWatchSubmissionsOlderThan(db, params));

  const result: RetentionResult = { turnEvals: 0, chats: 0, watches: 0, watchSubmissions: 0 };
  const failed: string[] = [];

  const cutoff = (retentionMs: number) => new Date(now.getTime() - retentionMs);

  // Drains rather than deleting one batch a day: the statement is capped, so a backlog
  // needs several of them.
  async function drain(name: string, purge: Purge, before: Date): Promise<number> {
    let total = 0;
    try {
      for (let batch = 0; batch < maxBatches; batch++) {
        const deleted = await purge({ before, limit });
        total += deleted;
        if (deleted < limit) break;
        if (batch === maxBatches - 1) {
          logger.warn(`dashboard-agent retention hit the batch cap: ${name}`, { total, before });
        }
      }
    } catch (error) {
      failed.push(name);
      logger.error(`dashboard-agent retention failed: ${name}`, { error: serializeError(error) });
    }
    return total;
  }

  result.turnEvals = await drain("turn evals", purgeTurnEvals, cutoff(TURN_EVAL_RETENTION_MS));
  result.chats = await drain("chats", purgeChats, cutoff(CHAT_SOFT_DELETE_RETENTION_MS));

  const watchesBefore = cutoff(WATCH_RETENTION_MS);
  result.watches = await drain("watches", purgeWatches, watchesBefore);
  // The ledger's rows age out on the same window: past it no client is still retrying.
  result.watchSubmissions = await drain("watch submissions", purgeWatchSubmissions, watchesBefore);

  if (failed.length > 0) {
    throw new Error(`The dashboard agent retention pass failed: ${failed.join(", ")}`);
  }

  return result;
}
