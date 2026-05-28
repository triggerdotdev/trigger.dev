import type { MollifierBuffer } from "@trigger.dev/redis-worker";
import { logger as defaultLogger } from "~/services/logger.server";
import { getMollifierBuffer } from "./mollifierBuffer.server";
import { MollifierStaleSweepState, type StaleSweepStateStore } from "./mollifierStaleSweepState.server";
import {
  recordStaleEntry as defaultRecordStaleEntry,
  reportStaleEntrySnapshot as defaultReportStaleEntrySnapshot,
} from "./mollifierTelemetry.server";

// One pass of the sweep scans a bounded slice of orgs from the buffer's
// queue LIST, identified by a durable cursor in Redis. Per-env entry
// scan is also bounded so a single pathological env can't extend the
// pass.
const DEFAULT_MAX_ENTRIES_PER_ENV = 1000;
// Max orgs visited per tick. Together with `maxEntriesPerEnv` this
// caps Redis traffic per pass. One "cycle" (visiting every org once)
// takes `ceil(N_orgs / cap)` ticks, after which the cursor wraps and a
// fresh org list is taken.
const DEFAULT_MAX_ORGS_PER_PASS = 100;

export type StaleSweepConfig = {
  // Entries whose dwell exceeds this threshold are flagged stale. Set
  // it well below `entryTtlSeconds * 1000` so ops have lead time before
  // TTL-induced silent loss; the default (half of entryTtlSeconds)
  // matches the cadence in the plan doc.
  staleThresholdMs: number;
  maxEntriesPerEnv?: number;
  // Hard cap on orgs visited per tick. Bounds the per-pass Redis traffic
  // and wall-time. Default 100 — at typical fleet sizes one or two
  // ticks cover everyone; under incident-scale fan-out a full cycle
  // takes a handful of ticks (~minutes) which is still well below the
  // staleness signal latency that ops cares about.
  maxOrgsPerPass?: number;
};

export type StaleSweepDeps = {
  getBuffer?: () => MollifierBuffer | null;
  // Durable cursor + per-env counts hash. Required: the sweep is
  // useless without persistent state across ticks. The webapp wires up
  // a real `MollifierStaleSweepState`; tests pass one constructed
  // against the test container.
  state: StaleSweepStateStore;
  // No `envId` arg — `envId` is a high-cardinality metric attribute and
  // is intentionally not emitted as a metric label. The structured warn
  // log below carries envId for forensic drill-down.
  recordStaleEntry?: () => void;
  reportStaleEntrySnapshot?: (snapshot: Map<string, number>) => void;
  logger?: { warn: (message: string, fields: Record<string, unknown>) => void };
  now?: () => number;
};

export type StaleSweepResult = {
  orgsScanned: number;
  envsScanned: number;
  entriesScanned: number;
  staleCount: number;
};

// Walks a bounded slice of `orgs → envs → entries`, emitting an OTel
// counter tick and a structured warning log for each buffer entry whose
// dwell exceeds the stale threshold. Read-only on the buffer's own
// state; writes only to the sweep's three dedicated keys
// (`mollifier:stale_sweep:*`). The sweep does NOT remove or salvage
// buffer entries; that decision is deferred to a separate retention-
// policy change. The signal here exists so ops sees the drainer falling
// behind well before TTL-induced loss kicks in.
//
// Sharding contract:
// - Cursor starts at 0. On cursor=0 the org list is refreshed by
//   snapshotting `buffer.listOrgs()` into the durable LIST — that is
//   the cycle's frozen view of orgs to visit.
// - Each tick consumes up to `maxOrgsPerPass` orgs from the LIST,
//   advances the cursor, and persists.
// - When the cursor reaches the end of the LIST it wraps to 0; the next
//   tick rebuilds the org list, capturing any orgs that joined the
//   buffer mid-cycle.
// - The per-env counts HASH carries over across ticks: an env visited
//   on tick N and not revisited until tick N+M keeps its last-known
//   stale count in the gauge for that window. This is the price of
//   sharding — accepted because the alternative (re-scan everything
//   every tick) does not bound work.
export async function runStaleSweepOnce(
  config: StaleSweepConfig,
  deps: StaleSweepDeps,
): Promise<StaleSweepResult> {
  const getBuffer = deps.getBuffer ?? getMollifierBuffer;
  const recordStale = deps.recordStaleEntry ?? defaultRecordStaleEntry;
  const reportSnapshot =
    deps.reportStaleEntrySnapshot ?? defaultReportStaleEntrySnapshot;
  const log = deps.logger ?? defaultLogger;
  const now = (deps.now ?? Date.now)();
  const maxEntries = config.maxEntriesPerEnv ?? DEFAULT_MAX_ENTRIES_PER_ENV;
  const maxOrgsPerPass = config.maxOrgsPerPass ?? DEFAULT_MAX_ORGS_PER_PASS;

  const buffer = getBuffer();
  if (!buffer) {
    // Replace any previous snapshot with empty so a previously-paging
    // env doesn't stay latched if mollifier is turned off mid-flight.
    // Also clear the durable state so a re-enable starts from a clean
    // slate instead of resuming on a stale cursor.
    await deps.state.clearAll();
    reportSnapshot(new Map());
    return { orgsScanned: 0, envsScanned: 0, entriesScanned: 0, staleCount: 0 };
  }

  let cursor = await deps.state.readCursor();
  if (cursor === 0) {
    // Fresh cycle — capture the current set of orgs into the frozen
    // LIST. Any orgs that join after this snapshot wait until the next
    // cycle to be visited. Acceptable for an observational sweep; the
    // staleness signal would only fire on entries that have been
    // dwelling for `staleThresholdMs` anyway, so they're not new.
    const orgs = await buffer.listOrgs();
    await deps.state.rebuildOrgList(orgs);
  }

  const { orgs: slice, total } = await deps.state.readOrgListSlice(
    cursor,
    maxOrgsPerPass,
  );

  let envsScanned = 0;
  let entriesScanned = 0;
  let staleCount = 0;

  for (const orgId of slice) {
    const envs = await buffer.listEnvsForOrg(orgId);
    for (const envId of envs) {
      envsScanned += 1;
      let envStale = 0;
      const entries = await buffer.listEntriesForEnv(envId, maxEntries);
      for (const entry of entries) {
        entriesScanned += 1;
        const dwellMs = now - entry.createdAt.getTime();
        if (dwellMs > config.staleThresholdMs) {
          recordStale();
          log.warn("mollifier.stale_entry", {
            runId: entry.runId,
            envId,
            orgId,
            dwellMs,
            staleThresholdMs: config.staleThresholdMs,
          });
          envStale += 1;
        }
      }
      // Persist the per-env count to the durable hash. HSET when stale
      // > 0, HDEL when it dropped back to zero — the hash is the source
      // of truth for the gauge snapshot below.
      await deps.state.setEnvStaleCount(envId, envStale);
      // Track that this env was visited during the current cycle. The
      // reconcile step at cycle wrap uses this to HDEL counts hash
      // entries for envs that fully drained mid-cycle (they disappear
      // from listEnvsForOrg, so the inner loop above never reaches them
      // and never HDELs their hash field — without reconcile the gauge
      // would stay elevated forever).
      await deps.state.markEnvVisited(envId);
      staleCount += envStale;
    }
  }

  // Advance the cursor. If the slice consumed the end of the LIST, wrap
  // to 0 so the next tick rebuilds the org list and starts a new cycle.
  const advanced = cursor + slice.length;
  const wrapped = advanced >= total;
  const newCursor = wrapped ? 0 : advanced;
  await deps.state.writeCursor(newCursor);

  if (wrapped) {
    // Cycle ended. HDEL any env still in the counts hash that didn't
    // appear in any tick of the just-completed cycle — these are envs
    // that fully drained from the buffer mid-cycle and would otherwise
    // hold their stale gauge value forever. Also DELs the visited set
    // so the next cycle starts clean.
    await deps.state.reconcileVisited();
  }

  // Emit the snapshot from the durable hash, which carries values for
  // envs visited in earlier ticks too. This is what makes the gauge
  // stable across ticks (and across webapp restarts).
  const snapshot = await deps.state.readAllEnvStaleCounts();
  reportSnapshot(snapshot);

  return { orgsScanned: slice.length, envsScanned, entriesScanned, staleCount };
}

export type StaleSweepIntervalHandle = {
  stop: () => Promise<void>;
};

// Production wrapper: schedule `runStaleSweepOnce` on a fixed interval.
// One pass at a time — if a sweep is still running when the timer fires
// the next tick is skipped (a backed-up Redis would otherwise queue
// overlapping sweeps that all log the same stale entries).
export function startStaleSweepInterval(
  config: StaleSweepConfig & { intervalMs: number },
  deps: StaleSweepDeps,
): StaleSweepIntervalHandle {
  let stopped = false;
  let inFlight = false;

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await runStaleSweepOnce(config, deps);
    } catch (err) {
      const log = deps.logger ?? defaultLogger;
      log.warn("mollifier.stale_sweep.failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, config.intervalMs);

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      // Close the durable-state Redis client if the deps own a real
      // `MollifierStaleSweepState`. Tests may inject a fake without a
      // `close()`; guard accordingly.
      if (deps.state instanceof MollifierStaleSweepState) {
        await deps.state.close();
      }
    },
  };
}
