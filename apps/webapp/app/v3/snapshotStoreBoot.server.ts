import { scanTargetsOf, type SnapshotStoreMode } from "@internal/run-store";
import { logger } from "~/services/logger.server";
import { globalFlagsRegistry } from "~/v3/globalFlagsRegistry.server";
import { getSnapshotRepairEnqueuer } from "./snapshotStoreBindings.server";
import { getSnapshotStoreConfig, getSnapshotSweepClient } from "./snapshotStoreInstance.server";

/**
 * Per node, because in cluster mode the policy is node-local: one replacement node brought up on a
 * default config evicts the slots it owns while every other node stays safe. `unknown` covers a
 * managed endpoint that refuses CONFIG GET, which is evidence of nothing either way.
 */
type EvictionPolicyReport =
  | { kind: "unknown"; reason: string }
  | { kind: "known"; nodes: { node: string; policy: string }[] };

export type SnapshotStoreBootDeps = {
  mode: SnapshotStoreMode;
  hostConfigured: boolean;
  completedTtlMs: number;
  orphanAgeMs: number;
  ping: () => Promise<boolean>;
  evictionPolicy: () => Promise<EvictionPolicyReport>;
  repairBound: () => boolean;
  log: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
};

const PING_TIMEOUT_MS = 5_000;
const FLAG_READY_TIMEOUT_MS = 10_000;

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
    } else {
      await assertNoEviction(deps);
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

/**
 * Refuses at every dial past off, unlike the reachability check above.
 *
 * An unreachable endpoint is a transient fault that heals itself and costs nothing below
 * redis-only, so refusing there would only bleed capacity. An evicting policy is static config
 * that will not heal, and it removes the keys that make a run's keyspace live: writes freeze,
 * reads fall back to Postgres for the rest of the run, and a birth landing after the eviction
 * restarts the entry sequence beneath a surviving index. The dial is a runtime flag that can be
 * raised to redis-read with no restart, so boot is the only place this is ever checked.
 */
async function assertNoEviction(deps: SnapshotStoreBootDeps): Promise<void> {
  const report = await deps.evictionPolicy();

  if (report.kind === "unknown") {
    deps.warn("Could not read the snapshot store maxmemory-policy; assuming noeviction", {
      mode: deps.mode,
      reason: report.reason,
    });
    return;
  }

  if (report.nodes.length === 0) {
    deps.warn("No snapshot store node reported a maxmemory-policy", { mode: deps.mode });
    return;
  }

  const evicting = report.nodes.filter((node) => node.policy !== "noeviction");
  if (evicting.length > 0) {
    const described = evicting.map((node) => `${node.node}=${node.policy}`).join(", ");
    throw new Error(
      `Snapshot store dial is "${deps.mode}" but the endpoint may evict keys (${described}); ` +
        "the mirror requires maxmemory-policy noeviction on every node. Refusing to start."
    );
  }
}

async function readEvictionPolicy(): Promise<EvictionPolicyReport> {
  const client = getSnapshotSweepClient();
  if (!client) {
    return { kind: "unknown", reason: "no snapshot store client" };
  }
  try {
    const nodes = await Promise.all(
      scanTargetsOf(client).map(async (node) => {
        const raw = (await node.config("GET", "maxmemory-policy")) as unknown;
        return {
          node: `${node.options.host ?? "unknown"}:${node.options.port ?? 0}`,
          policy: policyFromConfigGet(raw),
        };
      })
    );
    return { kind: "known", nodes };
  } catch (error) {
    return { kind: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** CONFIG GET answers as a flat [name, value] array on RESP2 and as a map on RESP3. */
function policyFromConfigGet(raw: unknown): string {
  if (Array.isArray(raw)) {
    return String(raw[1] ?? "");
  }
  if (raw && typeof raw === "object") {
    return String((raw as Record<string, unknown>)["maxmemory-policy"] ?? "");
  }
  return "";
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
  // Wait for the flag snapshot's first load. Without this the resolved dial is always the env
  // floor, because a cold registry returns undefined, and the configuration check would only ever
  // see a value no operator sets. A registry that never loads leaves the check on the floor, which
  // fails toward inert.
  await Promise.race([
    globalFlagsRegistry.isReady,
    new Promise<void>((resolve) => setTimeout(resolve, FLAG_READY_TIMEOUT_MS)),
  ]);

  const config = getSnapshotStoreConfig();

  await assertSnapshotStoreBoot({
    mode: config.mode,
    hostConfigured: config.configured,
    completedTtlMs: config.completedTtlMs,
    orphanAgeMs: config.orphanAgeMs,
    ping: pingSweepClient,
    evictionPolicy: readEvictionPolicy,
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
