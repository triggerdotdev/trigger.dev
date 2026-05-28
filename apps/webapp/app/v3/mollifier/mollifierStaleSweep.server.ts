import type { MollifierBuffer } from "@trigger.dev/redis-worker";
import { logger as defaultLogger } from "~/services/logger.server";
import { getMollifierBuffer } from "./mollifierBuffer.server";
import {
  recordStaleEntry as defaultRecordStaleEntry,
  reportStaleEntrySnapshot as defaultReportStaleEntrySnapshot,
} from "./mollifierTelemetry.server";

// One pass of the sweep scans every env's queue LIST. The per-env page
// is bounded so a single pathological env can't make the sweep run
// unboundedly long.
const DEFAULT_MAX_ENTRIES_PER_ENV = 1000;

export type StaleSweepConfig = {
  // Entries whose dwell exceeds this threshold are flagged stale. Set
  // it well below `entryTtlSeconds * 1000` so ops have lead time before
  // TTL-induced silent loss; the default (half of entryTtlSeconds)
  // matches the cadence in the plan doc.
  staleThresholdMs: number;
  maxEntriesPerEnv?: number;
};

export type StaleSweepDeps = {
  getBuffer?: () => MollifierBuffer | null;
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

// Walks orgs → envs → entries, emitting an OTel counter tick and a
// structured warning log for each buffer entry whose dwell exceeds the
// stale threshold. Read-only: the sweep does NOT remove or salvage
// entries; that decision is deferred to a separate retention-policy
// change. The signal here exists so ops sees the drainer falling
// behind well before TTL-induced loss kicks in.
export async function runStaleSweepOnce(
  config: StaleSweepConfig,
  deps: StaleSweepDeps = {},
): Promise<StaleSweepResult> {
  const getBuffer = deps.getBuffer ?? getMollifierBuffer;
  const recordStale = deps.recordStaleEntry ?? defaultRecordStaleEntry;
  const reportSnapshot =
    deps.reportStaleEntrySnapshot ?? defaultReportStaleEntrySnapshot;
  const log = deps.logger ?? defaultLogger;
  const now = (deps.now ?? Date.now)();
  const maxEntries = config.maxEntriesPerEnv ?? DEFAULT_MAX_ENTRIES_PER_ENV;

  const buffer = getBuffer();
  if (!buffer) {
    // Replace any previous snapshot with empty so a previously-paging
    // env doesn't stay latched if mollifier is turned off mid-flight.
    reportSnapshot(new Map());
    return { orgsScanned: 0, envsScanned: 0, entriesScanned: 0, staleCount: 0 };
  }

  const orgs = await buffer.listOrgs();
  let envsScanned = 0;
  let entriesScanned = 0;
  let staleCount = 0;
  // Tracks the stale count per env this pass. Includes zero counts for
  // envs that have entries but none stale — that's what lets the gauge
  // drop back to 0 when the drainer catches up. Envs absent from this
  // map are also absent from the new snapshot, clearing any latched
  // alerts on envs that have fully drained.
  const perEnvStale = new Map<string, number>();

  for (const orgId of orgs) {
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
      perEnvStale.set(envId, envStale);
      staleCount += envStale;
    }
  }

  reportSnapshot(perEnvStale);

  return { orgsScanned: orgs.length, envsScanned, entriesScanned, staleCount };
}

export type StaleSweepIntervalHandle = {
  stop: () => void;
};

// Production wrapper: schedule `runStaleSweepOnce` on a fixed interval.
// One pass at a time — if a sweep is still running when the timer fires
// the next tick is skipped (a backed-up Redis would otherwise queue
// overlapping sweeps that all log the same stale entries).
export function startStaleSweepInterval(
  config: StaleSweepConfig & { intervalMs: number },
  deps: StaleSweepDeps = {},
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
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
