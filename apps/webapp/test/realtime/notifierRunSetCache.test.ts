import { CURRENT_API_VERSION } from "~/api/versions";
import {
  NotifierRealtimeClient,
  type RealtimeListEnvironment,
} from "~/services/realtime/notifierRealtimeClient.server";
import { type RealtimeRunRow } from "~/services/realtime/electricStreamProtocol.server";
import { describe, expect, it, vi } from "vitest";

const ENV: RealtimeListEnvironment = { id: "env_1", organizationId: "org_1", projectId: "proj_1" };

function row(id: string): RealtimeRunRow {
  // Only id/createdAt/updatedAt are read directly; the rest serialize to null.
  return {
    id,
    createdAt: new Date("2026-06-07T09:00:00.000Z"),
    updatedAt: new Date("2026-06-07T10:00:00.000Z"),
  } as unknown as RealtimeRunRow;
}

function makeClient(overrides: Record<string, unknown> = {}) {
  const resolveSpy = vi.fn(async () => ["run_1", "run_2"]);
  const hydrateSpy = vi.fn(async (_env: string, ids: string[]) => ids.map(row));
  const never = { changed: new Promise<void>(() => {}), unsubscribe() {} };

  const client = new NotifierRealtimeClient({
    runReader: { getRunById: async () => null, hydrateByIds: hydrateSpy } as any,
    runListResolver: { resolveMatchingRunIds: resolveSpy } as any,
    notifier: { subscribeToRunChanges: () => never, subscribeToEnvChanges: () => never } as any,
    limiter: { incrementAndCheck: async () => true, decrement: async () => {} } as any,
    cachedLimitProvider: { getCachedLimit: async () => 100 },
    maximumCreatedAtFilterAgeMs: 24 * 60 * 60 * 1000,
    runSetResolveCacheTtlMs: 5_000,
    ...overrides,
  });

  return { client, resolveSpy, hydrateSpy };
}

// streamBatch with offset=-1 takes the snapshot path, which calls the coalescing
// resolve+hydrate directly (no concurrency slot / subscription needed).
function snapshot(client: NotifierRealtimeClient, batchId: string, skipColumns?: string) {
  const skip = skipColumns ? `&skipColumns=${skipColumns}` : "";
  return client.streamBatch(
    `http://localhost:3030/realtime/v1/batches/${batchId}?offset=-1${skip}`,
    ENV,
    batchId,
    CURRENT_API_VERSION,
    undefined,
    "1.0.0"
  );
}

// Tag-list snapshot (offset=-1) — exercises the createdAt bucketing + cache key.
function snapshotTag(client: NotifierRealtimeClient, tags: string[]) {
  return client.streamRuns(
    "http://localhost:3030/realtime/v1/runs?offset=-1",
    ENV,
    { tags },
    CURRENT_API_VERSION,
    undefined,
    "1.0.0"
  );
}

describe("NotifierRealtimeClient run-set resolve coalescing + cache", () => {
  it("coalesces concurrent same-filter resolves into one ClickHouse + Postgres query", async () => {
    const { client, resolveSpy, hydrateSpy } = makeClient();
    let release!: (ids: string[]) => void;
    const gate = new Promise<string[]>((resolve) => {
      release = resolve;
    });
    resolveSpy.mockReturnValueOnce(gate);

    const p1 = snapshot(client, "batch_1");
    const p2 = snapshot(client, "batch_1");
    release(["run_1"]);
    await Promise.all([p1, p2]);

    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(hydrateSpy).toHaveBeenCalledTimes(1);
  });

  it("serves a second same-filter request from the cache within the TTL", async () => {
    const { client, resolveSpy, hydrateSpy } = makeClient();
    await snapshot(client, "batch_1");
    await snapshot(client, "batch_1");
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(hydrateSpy).toHaveBeenCalledTimes(1);
  });

  it("does not share the cache across different filters", async () => {
    const { client, resolveSpy } = makeClient();
    await snapshot(client, "batch_1");
    await snapshot(client, "batch_2");
    expect(resolveSpy).toHaveBeenCalledTimes(2);
  });

  it("re-queries after the cache TTL expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { client, resolveSpy } = makeClient({ runSetResolveCacheTtlMs: 1_000 });
      await snapshot(client, "batch_1");
      vi.advanceTimersByTime(1_001);
      await snapshot(client, "batch_1");
      expect(resolveSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes the client's skipColumns through to the hydrator (column projection)", async () => {
    const { client, hydrateSpy } = makeClient();
    await snapshot(client, "batch_1", "payload,output");
    expect(hydrateSpy).toHaveBeenCalledWith("env_1", expect.any(Array), ["payload", "output"]);
  });

  it("reports resolve outcomes (miss then hit) to the metrics hook", async () => {
    const results: string[] = [];
    const { client } = makeClient({ onRunSetResolve: (r: string) => results.push(r) });
    await snapshot(client, "batch_1");
    await snapshot(client, "batch_1");
    expect(results).toEqual(["miss", "hit"]);
  });
});

describe("NotifierRealtimeClient tag-list createdAt bucketing", () => {
  it("floors the resolved createdAt lower bound to the bucket boundary", async () => {
    // Fix the clock to a non-bucket-aligned instant so the assertion is deterministic.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-07T10:00:30.500Z"));
    try {
      const { client, resolveSpy } = makeClient({ runSetCreatedAtBucketMs: 60_000 });
      await snapshotTag(client, ["critical"]);
      const passed = resolveSpy.mock.calls[0][0].createdAtAfter as Date;
      expect(passed.getTime() % 60_000).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets two same-tag feeds in the same bucket share one resolve", async () => {
    // A large bucket guarantees both windows floor to the same boundary regardless of
    // the sub-millisecond gap between the two calls.
    const { client, resolveSpy, hydrateSpy } = makeClient({
      runSetCreatedAtBucketMs: 60 * 60_000,
    });
    await snapshotTag(client, ["critical"]);
    await snapshotTag(client, ["critical"]);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(hydrateSpy).toHaveBeenCalledTimes(1);
  });

  it("does not share across different tags", async () => {
    const { client, resolveSpy } = makeClient({ runSetCreatedAtBucketMs: 60 * 60_000 });
    await snapshotTag(client, ["critical"]);
    await snapshotTag(client, ["debug"]);
    expect(resolveSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps each feed's exact lower bound when bucketing is disabled (0)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-07T10:00:30.500Z"));
    try {
      const { client, resolveSpy } = makeClient({ runSetCreatedAtBucketMs: 0 });
      await snapshotTag(client, ["critical"]);
      const passed = resolveSpy.mock.calls[0][0].createdAtAfter as Date;
      // Exact (now - 24h) lower bound, not floored to a 60s boundary.
      expect(passed.getTime() % 60_000).not.toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
