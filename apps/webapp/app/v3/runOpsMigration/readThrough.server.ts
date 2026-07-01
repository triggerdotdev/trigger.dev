/**
 * Read-through reads the LEGACY RUN-OPS READ REPLICA ONLY — never the legacy primary
 * (which carries the read load we are shedding). Disabled entirely when isSplitEnabled()
 * is false (single-DB passthrough).
 *
 * During the retention window, old not-yet-migrated run-ops rows are served off
 * the legacy read replica. A known-migrated filter short-circuits re-probing legacy for
 * runs already living on the new DB. After termination, past-retention runs return the
 * normal not-found response. Patterned on `mollifier/resolveRunForMutation.server.ts`
 * (`?? default` DI), but with the legacy-primary/writer fallback deliberately removed:
 * this layer has NO legacy-writer handle at all (structural guarantee).
 */
import type { PrismaReplicaClient } from "~/db.server";
import {
  runOpsLegacyReplica as defaultLegacyReplica,
  runOpsNewReplica as defaultNewClient,
} from "~/db.server";
import { logger as defaultLogger } from "~/services/logger.server";
import { ownerEngine, UnclassifiableRunId } from "@trigger.dev/core/v3/isomorphic";
import { isKnownMigrated as defaultIsKnownMigrated } from "./knownMigratedFilter.server";
import { isSplitEnabled } from "./splitMode.server";

export type ReadThroughSource = "new" | "legacy-replica";

export type ReadThroughResult<T> =
  | { source: ReadThroughSource; value: T }
  | { source: "not-found" }
  | { source: "past-retention" };

export type ReadThroughDeps = {
  newClient?: PrismaReplicaClient;
  legacyReplica?: PrismaReplicaClient;
  /** Resolved boot constant; never `await`ed per-request when supplied. */
  splitEnabled?: boolean;
  isKnownMigrated?: (runId: string) => Promise<boolean>;
  isPastRetention?: (runId: string) => boolean;
  logger?: { warn: (m: string, meta?: unknown) => void };
  /** Saturation-signal emit hook: called on each legacy-replica hit. */
  onLegacyReplicaRead?: (runId: string) => void;
};

type ReadThroughRunInput<T> = {
  runId: string;
  environmentId: string;
  readNew: (client: PrismaReplicaClient) => Promise<T | null>;
  readLegacy: (replica: PrismaReplicaClient) => Promise<T | null>;
  deps?: ReadThroughDeps;
};

export async function readThroughRun<T>(
  input: ReadThroughRunInput<T>
): Promise<ReadThroughResult<T>> {
  const { runId, deps } = input;
  const newClient = deps?.newClient ?? defaultNewClient;
  const legacyReplica = deps?.legacyReplica ?? defaultLegacyReplica;
  const logger = deps?.logger ?? defaultLogger;

  const splitEnabled = deps?.splitEnabled ?? (await isSplitEnabled());

  // Passthrough: single plain read against the one collapsed store. No legacy read,
  // no marker check, no isKnownMigrated, no second connection.
  if (!splitEnabled) {
    const v = await input.readNew(newClient);
    return v != null ? { source: "new", value: v } : { source: "not-found" };
  }

  // Split is on. Classify residency; an unclassifiable id is treated as LEGACY
  // (conservative — probe rather than drop a real run).
  let residency: "LEGACY" | "NEW";
  try {
    residency = ownerEngine(runId);
  } catch (e) {
    if (e instanceof UnclassifiableRunId) {
      logger.warn("readThroughRun: UnclassifiableRunId, treating as LEGACY", {
        runId,
        valueLength: e.valueLength,
      });
      residency = "LEGACY";
    } else {
      throw e;
    }
  }

  // A ksuid id can only live on the new DB — skip the legacy replica entirely.
  if (residency === "NEW") {
    const v = await input.readNew(newClient);
    return v != null ? { source: "new", value: v } : { source: "not-found" };
  }

  // LEGACY (or unclassifiable→LEGACY) fan-out: new first.
  const v = await input.readNew(newClient);
  if (v != null) {
    return { source: "new", value: v };
  }

  // Known-migrated short-circuit: the row is on new but the new read missed it
  // (lag / select shape). Do NOT re-probe legacy.
  const isMigrated = deps?.isKnownMigrated ?? defaultIsKnownMigrated;
  if (await isMigrated(runId)) {
    return { source: "not-found" };
  }

  // Legacy READ REPLICA only — never a legacy writer/primary (no such handle exists).
  const lv = await input.readLegacy(legacyReplica);
  if (lv != null) {
    deps?.onLegacyReplicaRead?.(runId);
    return { source: "legacy-replica", value: lv };
  }

  if (deps?.isPastRetention?.(runId)) {
    return { source: "past-retention" };
  }
  return { source: "not-found" };
}
