import type { SnapshotStoreMode } from "@internal/run-store";
import { logger } from "~/services/logger.server";
import { getSnapshotRepairEnqueuer } from "./snapshotStoreBindings.server";
import { getSnapshotStoreConfig, getSnapshotSweepClient } from "./snapshotStoreInstance.server";

export type SnapshotStoreBootDeps = {
  mode: SnapshotStoreMode;
  hostConfigured: boolean;
  completedTtlMs: number;
  orphanAgeMs: number;
  ping: () => Promise<boolean>;
  repairBound: () => boolean;
  log: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
};

const PING_TIMEOUT_MS = 5_000;

export async function assertSnapshotStoreBoot(deps: SnapshotStoreBootDeps): Promise<void> {
  const pastOff = deps.mode !== "off";

  if (pastOff && !deps.hostConfigured) {
    throw new Error(
      `Snapshot store dial is "${deps.mode}" but RUN_ENGINE_SNAPSHOT_STORE_REDIS_HOST is unset, so nothing is constructed; refusing to start.`
    );
  }

  if (pastOff && !(deps.completedTtlMs > 0)) {
    throw new Error("RUN_ENGINE_SNAPSHOT_STORE_COMPLETED_TTL_MS must be a positive integer.");
  }

  if (pastOff && !(deps.orphanAgeMs > 0)) {
    throw new Error("RUN_ENGINE_SNAPSHOT_STORE_ORPHAN_AGE_MS must be a positive integer.");
  }

  // Nothing enforces that a process which appends has imported the engine module, and an unbound
  // enqueuer loses every repair job silently — which burns a task attempt per lost repair.
  if (pastOff && !deps.repairBound()) {
    throw new Error(
      "Snapshot store dial is past off but the repair enqueuer is unbound; refusing to start."
    );
  }

  if (pastOff) {
    const reachable = await deps.ping();
    if (!reachable) {
      if (deps.mode === "redis-only") {
        throw new Error(
          "Snapshot store dial is redis-only and the endpoint is unreachable; refusing to start."
        );
      }
      // Postgres is authoritative below redis-only, so a lost append costs nothing. Refusing here
      // would bleed fleet capacity during a Redis fault to protect a write path that is free.
      deps.warn("Snapshot store Redis is unreachable; booting because Postgres is authoritative", {
        mode: deps.mode,
      });
    }
  }

  if (deps.mode === "redis-only") {
    deps.warn(
      "Snapshot store dial is redis-only but this build always writes Postgres snapshots. Double-writing is safe, but a Redis fault at this position fails run creation.",
      { mode: deps.mode }
    );
  }

  deps.log("snapshot store resolved", {
    mode: deps.mode,
    hostConfigured: deps.hostConfigured,
    completedTtlMs: deps.completedTtlMs,
    orphanAgeMs: deps.orphanAgeMs,
  });
}

async function pingSweepClient(): Promise<boolean> {
  const client = getSnapshotSweepClient();
  if (!client) {
    return false;
  }
  try {
    const result = await Promise.race([
      client.ping(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("ping timed out")), PING_TIMEOUT_MS)
      ),
    ]);
    return result === "PONG";
  } catch {
    return false;
  }
}

/** The env-reading adapter. The boot log line is not authoritative after boot: the dial can move. */
export async function assertSnapshotStoreBootFromEnv(): Promise<void> {
  const config = getSnapshotStoreConfig();

  await assertSnapshotStoreBoot({
    mode: config.mode,
    hostConfigured: config.configured,
    completedTtlMs: config.completedTtlMs,
    orphanAgeMs: config.orphanAgeMs,
    ping: pingSweepClient,
    repairBound: () => !!getSnapshotRepairEnqueuer(),
    log: (message, fields) =>
      logger.info(message, {
        ...fields,
        keyPrefix: config.keyPrefix,
        clusterMode: config.clusterMode,
      }),
    warn: (message, fields) => logger.warn(message, fields),
  });
}
