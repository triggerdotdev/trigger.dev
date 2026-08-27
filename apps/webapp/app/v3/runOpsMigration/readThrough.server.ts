/**
 * Read-through reads the LEGACY RUN-OPS READ REPLICA ONLY — never the legacy primary
 * (which carries the read load we are shedding). Disabled entirely when isSplitEnabled()
 * is false (single-DB passthrough).
 *
 * Residency is decided purely by id-shape, via `resolveShard`: a gen-2 body names its own
 * shard (ONE read there), a gen-1 v1 body reads new only, everything else is legacy and
 * routes on `idKind`.
 *
 * `idKind` is required because a cuid gives no way to tell a run id from a waitpoint id,
 * and the two must route differently: a legacy-classified RUN id is legacy-resident (there
 * is no cuid run migration), while a cuid WAITPOINT can be co-located with its run on the
 * new store, which is what makes the new-first probe load-bearing for it. No default —
 * a default would pick one of those arms silently.
 *
 * Patterned on `mollifier/resolveRunForMutation.server.ts` (`?? default` DI), but with the
 * legacy-primary/writer fallback deliberately removed: this layer has NO legacy-writer
 * handle at all (structural guarantee).
 */
import type { PrismaReplicaClient } from "~/db.server";
import {
  runOpsLegacyReplica as defaultLegacyReplica,
  runOpsNewReplica as defaultNewClient,
} from "~/db.server";
import { logger as defaultLogger } from "~/services/logger.server";
import { resolveShard, type ShardKey } from "@trigger.dev/core/v3/isomorphic";
import { isSplitEnabled } from "./splitMode.server";
import { runOpsShardReplicas } from "./shardHandles.server";

type ShardSource = `shard:${string}`;

type ReadThroughSource = "new" | "legacy-replica" | ShardSource;

/**
 * `found` carries hit/miss STRUCTURALLY. `source` is open-ended once shards exist, so a
 * consumer testing found-ness by listing hit sources reads a gen-2 hit as a miss;
 * discriminating on `found` makes that a compile error instead.
 */
export type ReadThroughResult<T> =
  | { found: true; source: ReadThroughSource; value: T }
  | { found: false; reason: "not-found" | "past-retention" };

type ReadThroughDeps = {
  newClient?: PrismaReplicaClient;
  legacyReplica?: PrismaReplicaClient;
  /**
   * Gen-2 shard replicas by shard char; empty (RUN_OPS_SHARDS unset) makes the gen-2 arm
   * unreachable. Load-bearing only for callers whose closures read a client DIRECTLY:
   * `RoutingRunStore` never forwards a caller's client, so for store-backed closures the
   * client picked here is only a read-your-writes signal. Not dead weight.
   */
  shardReplicas?: ReadonlyMap<ShardKey, PrismaReplicaClient>;
  /** Resolved boot constant; never `await`ed per-request when supplied. */
  splitEnabled?: boolean;
  isPastRetention?: (id: string) => boolean;
  logger?: { error: (m: string, meta?: Record<string, unknown>) => void };
  /** Saturation-signal emit hook: called on each legacy-replica hit. */
  onLegacyReplicaRead?: (id: string) => void;
};

type ReadThroughRunInput<T> = {
  id: string;
  idKind: "run" | "waitpoint";
  environmentId: string;
  readNew: (client: PrismaReplicaClient) => Promise<T | null>;
  readLegacy: (replica: PrismaReplicaClient) => Promise<T | null>;
  deps?: ReadThroughDeps;
};

function hit<T>(source: ReadThroughSource, value: T): ReadThroughResult<T> {
  return { found: true, source, value };
}

function miss<T>(reason: "not-found" | "past-retention"): ReadThroughResult<T> {
  return { found: false, reason };
}

export async function readThroughRun<T>(
  input: ReadThroughRunInput<T>
): Promise<ReadThroughResult<T>> {
  const { id, idKind, deps } = input;
  const newClient = deps?.newClient ?? defaultNewClient;
  const legacyReplica = deps?.legacyReplica ?? defaultLegacyReplica;
  const shardReplicas = deps?.shardReplicas ?? runOpsShardReplicas;
  const logger = deps?.logger ?? defaultLogger;

  const splitEnabled = deps?.splitEnabled ?? (await isSplitEnabled());

  // Passthrough: single plain read against the one collapsed store.
  if (!splitEnabled) {
    const v = await input.readNew(newClient);
    return v != null ? hit("new", v) : miss("not-found");
  }

  // Total: an unclassifiable id resolves to "legacy" (probe rather than drop a real run).
  const shardKey = resolveShard(id);

  if (shardKey !== "new" && shardKey !== "legacy") {
    const shardReplica = shardReplicas.get(shardKey);
    if (shardReplica === undefined) {
      // Deliberately not a throw: this id arrives from the caller (a URL param on the
      // waitpoint route) and any base32hex core + [a-z0-9] + "2" parses as gen-2, so a
      // throw is a 500 any client can induce. An error-logged not-found is neither silent
      // nor a misroute. Throwing stays correct on the router path, where ids are minted.
      logger.error("readThroughRun: gen-2 id resolved to an unconfigured shard key", {
        id,
        shardKey,
        configured: [...shardReplicas.keys()],
      });
      return miss("not-found");
    }
    // A gen-2 shard is a dedicated-schema store, exactly like `new`, so `readNew` fits.
    const v = await input.readNew(shardReplica);
    return v != null ? hit(`shard:${shardKey}`, v) : miss("not-found");
  }

  if (shardKey === "new") {
    const v = await input.readNew(newClient);
    return v != null ? hit("new", v) : miss("not-found");
  }

  if (idKind === "waitpoint") {
    const v = await input.readNew(newClient);
    if (v != null) {
      return hit("new", v);
    }
  }

  // Legacy READ REPLICA only — never a legacy writer/primary (no such handle exists).
  const lv = await input.readLegacy(legacyReplica);
  if (lv != null) {
    deps?.onLegacyReplicaRead?.(id);
    return hit("legacy-replica", lv);
  }

  if (deps?.isPastRetention?.(id)) {
    return miss("past-retention");
  }
  return miss("not-found");
}
