import { CURRENT_API_VERSION } from "~/api/versions";
import {
  NotifierRealtimeClient,
  type RealtimeListEnvironment,
} from "~/services/realtime/notifierRealtimeClient.server";
import { type RealtimeRunRow } from "~/services/realtime/electricStreamProtocol.server";
import { EnvChangeRouter } from "~/services/realtime/envChangeRouter.server";
import { setTimeout as sleep } from "node:timers/promises";
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

  const client = new NotifierRealtimeClient({
    runReader: { getRunById: async () => null, hydrateByIds: hydrateSpy } as any,
    runListResolver: { resolveMatchingRunIds: resolveSpy } as any,
    // No-op source: live polls never get a router wake, so they fall through to the
    // backstop full-resolve — which is what the live tests below assert on.
    router: new EnvChangeRouter({
      source: { subscribeToEnv: () => () => {} },
      hydrator: { hydrateByIds: hydrateSpy },
    }),
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

describe("NotifierRealtimeClient resolve admission gate (mass-reconnect stampede)", () => {
  // A resolver that blocks each invocation until released, so we can watch how many run
  // concurrently. Tracks peak concurrency and exposes a release-one-at-a-time drain.
  function gatedResolver() {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const resolve = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((r) => releases.push(r));
      active--;
      return ["run_1"];
    });
    return {
      resolve,
      peak: () => peak,
      releaseOne: () => releases.shift()?.(),
      waiting: () => releases.length,
    };
  }

  function makeGatedClient(resolveAdmissionLimit: number, resolver: ReturnType<typeof gatedResolver>) {
    const hydrateSpy = vi.fn(async (_env: string, ids: string[]) => ids.map(row));
    return new NotifierRealtimeClient({
      runReader: { getRunById: async () => null, hydrateByIds: hydrateSpy } as any,
      runListResolver: { resolveMatchingRunIds: resolver.resolve } as any,
      router: new EnvChangeRouter({
        source: { subscribeToEnv: () => () => {} },
        hydrator: { hydrateByIds: hydrateSpy },
      }),
      limiter: { incrementAndCheck: async () => true, decrement: async () => {} } as any,
      cachedLimitProvider: { getCachedLimit: async () => 100 },
      maximumCreatedAtFilterAgeMs: 24 * 60 * 60 * 1000,
      runSetResolveCacheTtlMs: 0, // no cache -> every distinct filter is a fresh resolve
      resolveAdmissionLimit,
    });
  }

  it("throttles a distinct-filter stampede to the admission limit of concurrent CH resolves", async () => {
    const resolver = gatedResolver();
    const client = makeGatedClient(2, resolver);

    // 5 distinct batchIds => 5 distinct filters => 5 fresh resolves, fired at once.
    const polls = [0, 1, 2, 3, 4].map((i) => snapshot(client, `batch_${i}`));

    // Only the limit (2) may run concurrently; the rest queue for a permit.
    await vi.waitFor(() => expect(resolver.resolve).toHaveBeenCalledTimes(2));
    await sleep(20);
    expect(resolver.resolve).toHaveBeenCalledTimes(2); // 3 still queued behind the gate
    expect(resolver.peak()).toBe(2);

    // Drain: each release frees a permit, admitting exactly one queued resolve.
    while (resolver.waiting() > 0) {
      resolver.releaseOne();
      await sleep(5);
    }
    await Promise.all(polls);

    expect(resolver.resolve).toHaveBeenCalledTimes(5); // all ran...
    expect(resolver.peak()).toBe(2); // ...but never more than the limit at once
  });

  it("lets a same-filter burst through on a single permit (coalesces before the gate)", async () => {
    const resolver = gatedResolver();
    const client = makeGatedClient(1, resolver); // limit 1 would deadlock if each took a permit

    // 5 identical filters fired at once -> single-flight collapses to one in-flight resolve.
    const polls = [0, 1, 2, 3, 4].map(() => snapshot(client, "batch_same"));
    await vi.waitFor(() => expect(resolver.resolve).toHaveBeenCalledTimes(1));
    await sleep(20);

    resolver.releaseOne();
    await Promise.all(polls);
    expect(resolver.resolve).toHaveBeenCalledTimes(1); // one resolve, one permit, no queue
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

  it("does not collide a comma-containing tag with two separate tags", async () => {
    const { client, resolveSpy } = makeClient({ runSetCreatedAtBucketMs: 60 * 60_000 });
    await snapshotTag(client, ["a,b"]); // one tag "a,b"
    await snapshotTag(client, ["a", "b"]); // two tags a OR b — a different filter
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

describe("NotifierRealtimeClient review fixes", () => {
  // makeClient's router has a no-op source, so the live poll never gets a wake and falls
  // through to its backstop timeout — the full ClickHouse resolve these tests assert on
  // (createdAt clamp / concurrency limit).

  it("clamps a stale/crafted handle's createdAt up to the max-age floor", async () => {
    const maxAge = 24 * 60 * 60 * 1000;
    const { client, resolveSpy } = makeClient({
      maximumCreatedAtFilterAgeMs: maxAge,
      runSetCreatedAtBucketMs: 0,
      livePollTimeoutMs: 50,
    });
    const before = Date.now();
    // Handle encodes createdAt = 1ms epoch, far older than the 24h ceiling.
    await client.streamRuns(
      "http://localhost:3030/realtime/v1/runs?offset=123_1&live=true&handle=runs_1_7",
      ENV,
      { tags: ["t"] },
      CURRENT_API_VERSION,
      undefined,
      "1.0.0"
    );
    const passed = resolveSpy.mock.calls[0][0].createdAtAfter as Date;
    // Clamped to ~now - maxAge, not the epoch value encoded in the handle.
    expect(passed.getTime()).toBeGreaterThan(before - maxAge - 1_000);
  });

  it("enforces a concurrency limit of 0 instead of failing with a 500", async () => {
    let limitCheckedWith: number | undefined;
    const { client } = makeClient({
      cachedLimitProvider: { getCachedLimit: async () => 0 },
      limiter: {
        incrementAndCheck: async (_env: string, _id: string, limit: number) => {
          limitCheckedWith = limit;
          return true;
        },
        decrement: async () => {},
      },
      livePollTimeoutMs: 50,
    });
    const res = await client.streamBatch(
      "http://localhost:3030/realtime/v1/batches/batch_1?offset=123_1&live=true",
      ENV,
      "batch_1",
      CURRENT_API_VERSION,
      undefined,
      "1.0.0"
    );
    expect(res.status).toBe(200);
    expect(limitCheckedWith).toBe(0);
  });
});
