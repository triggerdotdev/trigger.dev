import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { shouldUseV2RunTable, type ShouldUseV2RunTableOptions } from "~/v3/runTableV2.server";

/**
 * Cached, periodically-refreshed facts about the `task_run_v2` table, read OFF
 * the trigger hot path (no per-request DB query) to gate v2 minting and
 * cross-table read scoping.
 */
type RunTableV2Status = {
  /**
   * Is `task_run_v2` in the ClickHouse logical-replication publication?
   *
   * Postgres only decodes a table's changes for transactions that BEGIN after
   * the decoder sees `ALTER PUBLICATION ... ADD TABLE`, and that ADD TABLE is run
   * lazily by the replication leader on its own startup, NOT by a migration. So a
   * v2 run minted before the table is published is permanently absent from
   * ClickHouse with no backfill, and the run list / metrics / tags / bulk actions
   * are ClickHouse-only. Mint v2 ONLY when this is true; otherwise mint legacy
   * (fail-safe), self-healing once the leader publishes the table.
   */
  published: boolean;
  /**
   * Has any v2 run ever existed (monotonic in practice)? Cross-table READ scoping
   * uses this (OR the native master switch) rather than the master switch alone,
   * so disabling native realtime cannot re-scope reads back to legacy and hide
   * already-minted v2 runs from idempotency dedup and hierarchy reads.
   */
  hasRows: boolean;
};

const REFRESH_INTERVAL_MS = 30_000;

const status = singleton("runTableV2Status", initialize);

function initialize(): RunTableV2Status {
  const state: RunTableV2Status = { published: false, hasRows: false };

  // No background poller under vitest: this module is imported by the mint/read
  // sites, so a live DB poll + setInterval at import time would query the test
  // database and leak a timer for the test run, and the async refresh could race
  // tests that drive the cached status directly. Tests exercise the gates by
  // mutating the cached state, so the poller would only get in the way.
  if (env.NODE_ENV === "test") {
    return state;
  }

  // The publication only exists when runs replication is configured. Without it
  // no v2 run can be captured by ClickHouse, so leave published=false: minting
  // stays on legacy regardless of org flags.
  if (!env.RUN_REPLICATION_CLICKHOUSE_URL) {
    return state;
  }

  const refresh = async () => {
    try {
      const published = await prisma.$queryRaw<Array<{ present: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM pg_publication_tables
          WHERE pubname = ${env.RUN_REPLICATION_PUBLICATION_NAME}
            AND schemaname = 'public'
            AND tablename = 'task_run_v2'
        ) AS present`;
      state.published = published[0]?.present ?? false;

      // hasRows is monotonic; once true, stop probing.
      if (!state.hasRows) {
        const hasRows = await prisma.$queryRaw<Array<{ present: boolean }>>`
          SELECT EXISTS (SELECT 1 FROM task_run_v2 LIMIT 1) AS present`;
        state.hasRows = hasRows[0]?.present ?? false;
      }
    } catch (error) {
      logger.warn("runTableV2Status refresh failed; keeping last-known status", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  void refresh();
  const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
  timer.unref?.();

  return state;
}

/** `task_run_v2` is in the ClickHouse replication publication (cached, off the hot path). */
export function isV2RunTablePublished(): boolean {
  return status.published;
}

/**
 * Whether a v2 run could be relevant to a cross-table READ: native realtime is on
 * (v2 is being minted now) OR `task_run_v2` already holds rows. Scope cross-table
 * reads on this, not the native master switch alone, so turning native off cannot
 * hide already-minted v2 runs.
 */
export function v2RunsMayExist(nativeRealtimeEnabled: boolean): boolean {
  return nativeRealtimeEnabled || status.hasRows;
}

/**
 * Mint gate: mint a v2 (KSUID) run only when the org is cut over to v2 AND
 * `task_run_v2` is in the ClickHouse publication, so a v2 run can never be
 * silently lost from ClickHouse by being minted before the replication leader
 * publishes the table. Fails safe to legacy until then; self-heals once published.
 */
export function canMintV2Run(
  orgFeatureFlags: unknown,
  options: ShouldUseV2RunTableOptions
): boolean {
  return shouldUseV2RunTable(orgFeatureFlags, options) && isV2RunTablePublished();
}
