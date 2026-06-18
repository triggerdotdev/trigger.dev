import { redisTest } from "@internal/testcontainers";
import { setTimeout as sleep } from "node:timers/promises";
import { CURRENT_API_VERSION } from "~/api/versions";
import { EnvChangeRouter } from "~/services/realtime/envChangeRouter.server";
import {
  NativeRealtimeClient,
  type RealtimeListEnvironment,
} from "~/services/realtime/nativeRealtimeClient.server";
import {
  InMemoryReplayCursorStore,
  RedisReplayCursorStore,
  type ReplayCursorStore,
} from "~/services/realtime/replayCursorStore.server";
import { describe, expect, it, vi } from "vitest";

describe("InMemoryReplayCursorStore", () => {
  it("round-trips and expires", async () => {
    const store = new InMemoryReplayCursorStore(50, 10);
    store.set("env_1:h1", 123_456);
    expect(await store.get("env_1:h1")).toBe(123_456);
    expect(await store.get("env_1:other")).toBeUndefined();
    await sleep(60);
    expect(await store.get("env_1:h1")).toBeUndefined();
  });
});

describe("RedisReplayCursorStore", () => {
  redisTest("round-trips, misses, and expires via PX", async ({ redisOptions }) => {
    const store = new RedisReplayCursorStore({
      redis: { ...redisOptions, tlsDisabled: true },
      ttlMs: 150,
    });
    try {
      const now = Date.now();
      store.set("env_1:h1", now);
      await vi.waitFor(async () => expect(await store.get("env_1:h1")).toBe(now));
      expect(await store.get("env_1:missing")).toBeUndefined();
      await sleep(200);
      expect(await store.get("env_1:h1")).toBeUndefined();
    } finally {
      await store.quit();
    }
  });

  redisTest("a second store instance reads the first's cursor (fleet sharing)", async ({
    redisOptions,
  }) => {
    const a = new RedisReplayCursorStore({
      redis: { ...redisOptions, tlsDisabled: true },
      ttlMs: 60_000,
    });
    const b = new RedisReplayCursorStore({
      redis: { ...redisOptions, tlsDisabled: true },
      ttlMs: 60_000,
    });
    try {
      a.set("env_1:h2", 42_000);
      await vi.waitFor(async () => expect(await b.get("env_1:h2")).toBe(42_000));
    } finally {
      await Promise.all([a.quit(), b.quit()]);
    }
  });

  it("degrades to undefined within the read deadline when Redis is unreachable", async () => {
    const results: Array<[string, boolean]> = [];
    const store = new RedisReplayCursorStore({
      redis: { host: "127.0.0.1", port: 1, tlsDisabled: true } as any,
      ttlMs: 1_000,
      getTimeoutMs: 100,
      onResult: (op, ok) => results.push([op, ok]),
    });
    try {
      expect(await store.get("env_1:h3")).toBeUndefined();
      expect(results).toContainEqual(["get", false]);
    } finally {
      await store.quit().catch(() => {});
    }
  });
});

describe("NativeRealtimeClient replay-cursor threading", () => {
  const ENV: RealtimeListEnvironment = { id: "env_1", organizationId: "org_1", projectId: "proj_1" };
  const FLOOR_MS = Date.UTC(2026, 5, 7, 12, 0, 0);

  it("passes the stored cursor to register and stamps the store after responding", async () => {
    const cursorMs = Date.now() - 500;
    const gets: string[] = [];
    const sets: Array<[string, number]> = [];
    const store: ReplayCursorStore = {
      get: async (key) => {
        gets.push(key);
        return cursorMs;
      },
      set: (key, ms) => {
        sets.push([key, ms]);
      },
    };

    const router = new EnvChangeRouter({
      source: { subscribeToEnv: () => () => {} },
      hydrator: { hydrateByIds: async () => [] },
      replayWindowMs: 0,
      unsubscribeLingerMs: 0,
    });
    const registerSpy = vi.spyOn(router, "register");

    const client = new NativeRealtimeClient({
      runReader: { getRunById: async () => null, hydrateByIds: async () => [] } as any,
      runListResolver: { resolveMatchingRunIds: async () => [] } as any,
      router,
      limiter: { incrementAndCheck: async () => true, decrement: async () => {} } as any,
      cachedLimitProvider: { getCachedLimit: async () => 100 },
      maximumCreatedAtFilterAgeMs: 100 * 365 * 24 * 60 * 60 * 1000,
      runSetResolveCacheTtlMs: 0,
      livePollTimeoutMs: 30,
      replayCursorStore: store,
    });

    const res = await client.streamRuns(
      `http://localhost:3030/realtime/v1/runs?offset=${FLOOR_MS}_1&live=true&handle=runs_${FLOOR_MS}_7`,
      ENV,
      { tags: ["t"] },
      CURRENT_API_VERSION,
      undefined,
      "1.0.0"
    );

    expect(res.status).toBe(200);
    expect(gets).toEqual([`env_1:runs_${FLOOR_MS}_7`]);
    expect(registerSpy).toHaveBeenCalledWith(
      "env_1",
      expect.objectContaining({ kind: "tag" }),
      expect.anything(),
      { replaySinceMs: cursorMs }
    );
    // The backstop's up-to-date response stamps the cursor for the next poll.
    expect(sets.length).toBe(1);
    expect(sets[0][0]).toBe(`env_1:runs_${FLOOR_MS}_7`);
    expect(sets[0][1]).toBeGreaterThanOrEqual(cursorMs);
  });
});
