// M3 cluster slot proof: a run's prep + run + pending keys share ONE cluster slot, so prepare and
// finalize (each a multi-key Lua touching all three families) run without CROSSSLOT. A standalone
// testcontainer cannot detect CROSSSLOT, so this stands up a throwaway local Redis Cluster with the
// homebrew redis-server, asserts, and tears it down. Skipped when redis-server is unavailable.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedisClusterClient, type Cluster } from "@internal/redis";
import {
  RedisSnapshotStore,
  type PreparedPgUnit,
  type SnapshotEntryInput,
} from "./redisSnapshotStore.js";
import { pendingStreamKeyForRun, preparedUnitKey, snapshotKeys } from "./snapshotKeys.js";
import { slotOf } from "@internal/testcontainers";

function hasRedisServer(): boolean {
  for (const p of [
    "/opt/homebrew/bin/redis-server",
    "/usr/local/bin/redis-server",
    "/usr/bin/redis-server",
  ]) {
    if (existsSync(p)) return true;
  }
  return false;
}

function redisServerPath(): string {
  return [
    "/opt/homebrew/bin/redis-server",
    "/usr/local/bin/redis-server",
    "/usr/bin/redis-server",
  ].find(existsSync)!;
}

function redisCliPath(): string {
  return ["/opt/homebrew/bin/redis-cli", "/usr/local/bin/redis-cli", "/usr/bin/redis-cli"].find(
    existsSync
  )!;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

// Opt-in (RUN_REDIS_CLUSTER_TEST=1): the real-cluster spin is slow/flaky; co-location is proven
// deterministically in snapshotKeys.slots.test.ts (same {pNNN} tag => same slot).
const RUN_CLUSTER = hasRedisServer() && process.env.RUN_REDIS_CLUSTER_TEST === "1";

describe.skipIf(!RUN_CLUSTER)("cluster key slots", () => {
  let procs: ChildProcess[] = [];
  let dir = "";
  let ports: number[] = [];
  let cluster: Cluster;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "snap-cluster-"));
    ports = [await freePort(), await freePort(), await freePort()];
    for (const port of ports) {
      procs.push(
        spawn(
          redisServerPath(),
          [
            "--port",
            String(port),
            "--cluster-enabled",
            "yes",
            "--cluster-config-file",
            join(dir, `nodes-${port}.conf`),
            "--cluster-node-timeout",
            "2000",
            "--dir",
            dir,
            "--save",
            "",
            "--appendonly",
            "no",
          ],
          { stdio: "ignore" }
        )
      );
    }

    // Wait for every node to accept connections before forming the cluster.
    for (const port of ports) {
      await waitFor(() => pinged(port));
    }
    execFileSync(
      redisCliPath(),
      [
        "--cluster",
        "create",
        ...ports.map((p) => `127.0.0.1:${p}`),
        "--cluster-replicas",
        "0",
        "--cluster-yes",
      ],
      { stdio: "ignore" }
    );
    // Wait until the cluster reports ok on the first node.
    await waitFor(() => clusterOk(ports[0]));

    cluster = createRedisClusterClient({
      nodes: ports.map((port) => ({ host: "127.0.0.1", port })),
    });
    await waitFor(async () => {
      try {
        await cluster.set("{warmup}probe", "1");
        return true;
      } catch {
        return false;
      }
    });
  }, 60_000);

  afterAll(async () => {
    try {
      await cluster?.quit();
    } catch {
      // ignore
    }
    for (const port of ports) {
      try {
        execFileSync(redisCliPath(), ["-p", String(port), "shutdown", "nosave"], {
          stdio: "ignore",
        });
      } catch {
        // SHUTDOWN closes the socket, which redis-cli surfaces as an error; the node is down regardless.
      }
    }
    for (const proc of procs) proc.kill("SIGKILL");
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("prep, run, and pending keys of a run share one slot", () => {
    const runId = "run_cluster_slot";
    const k = snapshotKeys(runId);
    const keys = [k.e, k.idx, k.cur, k.seq, preparedUnitKey(runId), pendingStreamKeyForRun(runId)];
    const slots = new Set(keys.map(slotOf));
    expect(slots.size).toBe(1);
  });

  it("prepare and finalize run on a real cluster without CROSSSLOT", async () => {
    // If any key of the run fell in a different slot, these multi-key scripts would error CROSSSLOT
    // on a real cluster. Success proves the {pNNN} hash tag keeps the whole run in one slot.
    const store = new RedisSnapshotStore({ client: cluster, completedTtlMs: 60_000 });
    const runId = "run_cluster_e2e";
    await store.append({ entry: entry(runId, "s0"), kind: "birth", isTerminal: false });

    const u: PreparedPgUnit = {
      protocolVersion: 1,
      transitionToken: "t",
      postgresXid: "1",
      runId,
      organizationId: "org_1",
      residency: "mirrored",
      logicalRunStoreRoute: "l",
      entries: [
        { entry: entry(runId, "s1"), kind: "transition", isTerminal: false, expectedCur: "s0" },
        { entry: entry(runId, "s2"), kind: "transition", isTerminal: false, expectedCur: "s1" },
      ],
    };
    expect((await store.prepare(u)).outcome).toBe("prepared");
    expect(await store.finalize(runId, "t")).toEqual({ outcome: "finalized", head: "s2" });
    expect((await store.getLatest(runId))?.id).toBe("s2");
  });
});

// Replica'd cluster (3 masters + 3 replicas): prove committed snapshot state survives losing the
// master that owns a run's slot. Slot co-location alone says nothing about durability, so this kills
// the owning master, waits for its replica to be promoted, then re-reads and re-writes the same run.
describe.skipIf(!RUN_CLUSTER)("cluster failover", () => {
  let procs: Map<number, ChildProcess> = new Map();
  let dir = "";
  let ports: number[] = [];
  let cluster: Cluster;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "snap-cluster-fo-"));
    ports = [];
    for (let i = 0; i < 6; i++) ports.push(await freePort());
    for (const port of ports) {
      procs.set(
        port,
        spawn(
          redisServerPath(),
          [
            "--port",
            String(port),
            "--cluster-enabled",
            "yes",
            "--cluster-config-file",
            join(dir, `nodes-${port}.conf`),
            "--cluster-node-timeout",
            "2000",
            "--dir",
            dir,
            "--save",
            "",
            "--appendonly",
            "no",
          ],
          { stdio: "ignore" }
        )
      );
    }

    for (const port of ports) {
      await waitFor(() => pinged(port));
    }
    execFileSync(
      redisCliPath(),
      [
        "--cluster",
        "create",
        ...ports.map((p) => `127.0.0.1:${p}`),
        "--cluster-replicas",
        "1",
        "--cluster-yes",
      ],
      { stdio: "ignore" }
    );
    await waitFor(() => clusterOk(ports[0]));

    cluster = createRedisClusterClient({
      nodes: ports.map((port) => ({ host: "127.0.0.1", port })),
    });
    await waitFor(async () => {
      try {
        await cluster.set("{warmup}probe", "1");
        return true;
      } catch {
        return false;
      }
    });
  }, 90_000);

  afterAll(async () => {
    try {
      await cluster?.quit();
    } catch {
      // ignore
    }
    for (const port of ports) {
      try {
        execFileSync(redisCliPath(), ["-p", String(port), "shutdown", "nosave"], {
          stdio: "ignore",
        });
      } catch {
        // SHUTDOWN closes the socket, which redis-cli surfaces as an error; the node is down regardless.
      }
    }
    for (const proc of procs.values()) proc.kill("SIGKILL");
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("committed snapshot state survives a master failover", async () => {
    const store = new RedisSnapshotStore({ client: cluster, completedTtlMs: 60_000 });
    const runId = "run_cluster_failover";

    // Write a fully committed run: birth s0, then a prepared+finalized transition to s2.
    await store.append({ entry: entry(runId, "s0"), kind: "birth", isTerminal: false });
    const u: PreparedPgUnit = {
      protocolVersion: 1,
      transitionToken: "t0",
      postgresXid: "1",
      runId,
      organizationId: "org_1",
      residency: "mirrored",
      logicalRunStoreRoute: "l",
      entries: [
        { entry: entry(runId, "s1"), kind: "transition", isTerminal: false, expectedCur: "s0" },
        { entry: entry(runId, "s2"), kind: "transition", isTerminal: false, expectedCur: "s1" },
      ],
    };
    expect((await store.prepare(u)).outcome).toBe("prepared");
    expect(await store.finalize(runId, "t0")).toEqual({ outcome: "finalized", head: "s2" });

    // Find the master that owns this run's slot and kill it.
    const slot = slotOf(preparedUnitKey(runId));
    const killedPort = await masterPortForSlot(cluster, slot);
    expect(ports).toContain(killedPort);
    execFileSync(redisCliPath(), ["-p", String(killedPort), "shutdown", "nosave"], {
      stdio: "ignore",
    });
    procs.get(killedPort)?.kill("SIGKILL");
    const survivor = ports.find((p) => p !== killedPort)!;

    // Wait for a replica to be promoted: the cluster returns to ok and the slot has a new master.
    await waitFor(async () => {
      if (!clusterOk(survivor)) return false;
      try {
        const owner = await masterPortForSlot(cluster, slot);
        return owner !== killedPort && ports.includes(owner);
      } catch {
        return false;
      }
    }, 60_000);

    // The committed head survived the failover, and the run still accepts a new prepare+finalize.
    expect((await store.getLatest(runId))?.id).toBe("s2");
    const u2: PreparedPgUnit = {
      protocolVersion: 1,
      transitionToken: "t1",
      postgresXid: "2",
      runId,
      organizationId: "org_1",
      residency: "mirrored",
      logicalRunStoreRoute: "l",
      entries: [
        { entry: entry(runId, "s3"), kind: "transition", isTerminal: false, expectedCur: "s2" },
      ],
    };
    expect((await store.prepare(u2)).outcome).toBe("prepared");
    expect(await store.finalize(runId, "t1")).toEqual({ outcome: "finalized", head: "s3" });
    expect((await store.getLatest(runId))?.id).toBe("s3");
  }, 90_000);
});

// The port of the master currently serving `slot`, from the cluster's live CLUSTER SLOTS view.
async function masterPortForSlot(cluster: Cluster, slot: number): Promise<number> {
  const slots = (await cluster.cluster("SLOTS")) as Array<[number, number, [string, number]]>;
  for (const range of slots) {
    if (slot >= range[0] && slot <= range[1]) return range[2][1];
  }
  throw new Error(`no master found for slot ${slot}`);
}

function entry(runId: string, id: string): SnapshotEntryInput {
  return {
    id,
    engine: "V2",
    executionStatus: "EXECUTING",
    description: "d",
    runId,
    runStatus: "EXECUTING",
    createdAt: "2026-08-21T00:00:00.000Z",
    environmentId: "env_1",
    environmentType: "PRODUCTION",
    projectId: "proj_1",
    organizationId: "org_1",
  };
}

function pinged(port: number): boolean {
  try {
    return execFileSync(redisCliPath(), ["-p", String(port), "ping"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .includes("PONG");
  } catch {
    return false;
  }
}

function clusterOk(port: number): boolean {
  try {
    return execFileSync(redisCliPath(), ["-p", String(port), "cluster", "info"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .includes("cluster_state:ok");
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timed out waiting for the local cluster");
}
