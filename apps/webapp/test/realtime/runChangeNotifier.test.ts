import { redisTest } from "@internal/testcontainers";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  type ChangeRecord,
  decodeChangeRecord,
  encodeChangeRecord,
  RunChangeNotifier,
} from "~/services/realtime/runChangeNotifier.server";

function toRedisOptions(redisOptions: { host?: string; port?: number; password?: string }) {
  return {
    host: redisOptions.host,
    port: redisOptions.port,
    password: redisOptions.password,
    tlsDisabled: true,
    clusterMode: false,
  };
}

// Time for a SUBSCRIBE to register server-side before we publish.
const SUBSCRIBE_SETTLE_MS = 250;

describe("RunChangeNotifier", () => {
  redisTest(
    "delivers a published change to an env subscriber",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const notifier = new RunChangeNotifier({ redis: toRedisOptions(redisOptions) });
      try {
        const received: ChangeRecord[] = [];
        const unsubscribe = notifier.subscribeToEnv("env_1", (records) =>
          received.push(...records)
        );
        expect(notifier.activeSubscriptionCount).toBe(1);

        await sleep(SUBSCRIBE_SETTLE_MS);
        notifier.publish({ runId: "run_1", envId: "env_1", tags: ["a"], batchId: "batch_1" });

        await vi.waitFor(() => expect(received.some((r) => r.runId === "run_1")).toBe(true), {
          timeout: 5_000,
          interval: 50,
        });
        const got = received.find((r) => r.runId === "run_1")!;
        expect(got.tags).toEqual(["a"]);
        expect(got.batchId).toBe("batch_1");

        unsubscribe();
        // Cleanup is deferred until Redis confirms UNSUBSCRIBE, so the count converges to 0.
        await vi.waitFor(() => expect(notifier.activeSubscriptionCount).toBe(0), {
          timeout: 5_000,
          interval: 50,
        });
      } finally {
        await notifier.quit();
      }
    }
  );

  redisTest(
    "does not deliver a change for a different env",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const notifier = new RunChangeNotifier({ redis: toRedisOptions(redisOptions) });
      try {
        const received: ChangeRecord[] = [];
        notifier.subscribeToEnv("env_a", (records) => received.push(...records));

        await sleep(SUBSCRIBE_SETTLE_MS);
        notifier.publish({ runId: "run_1", envId: "env_b", tags: [] }); // different env
        await sleep(500);

        expect(received).toHaveLength(0);
      } finally {
        await notifier.quit();
      }
    }
  );

  redisTest(
    "coalesces a burst of env publishes into far fewer batches than publishes (lossless)",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const notifier = new RunChangeNotifier({
        redis: toRedisOptions(redisOptions),
        envWakeCoalesceWindowMs: 100,
      });
      try {
        let batches = 0;
        const runIds = new Set<string>();
        notifier.subscribeToEnv("env_burst", (records) => {
          batches++;
          for (const r of records) runIds.add(r.runId);
        });

        await sleep(SUBSCRIBE_SETTLE_MS);
        let pubs = 0;
        const end = Date.now() + 1_000;
        while (Date.now() < end) {
          notifier.publish({ runId: `r${pubs++}`, envId: "env_burst", tags: [] });
          await sleep(5);
        }
        await sleep(300);

        expect(pubs).toBeGreaterThan(100);
        expect(batches).toBeGreaterThanOrEqual(1);
        // Leading-edge throttle: far fewer deliveries than publishes...
        expect(batches).toBeLessThan(pubs / 4);
        // ...but lossless — the batch accumulates every run that changed in the window.
        expect(runIds.size).toBeGreaterThan(pubs / 2);
      } finally {
        await notifier.quit();
      }
    }
  );

  // Sharded pub/sub (SSUBSCRIBE/SPUBLISH/smessage) wiring — validated end to end on a
  // single node (Redis 7.2 accepts these and delivers same-node). Multi-shard ROUTING
  // needs a real cluster (the cluster fixture covers that); this proves the command path.
  redisTest(
    "delivers via sharded pub/sub on the env channel",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const notifier = new RunChangeNotifier({
        redis: toRedisOptions(redisOptions),
        shardedPubSub: true,
      });
      try {
        const received: ChangeRecord[] = [];
        notifier.subscribeToEnv("env_sharded", (records) => received.push(...records));

        await sleep(SUBSCRIBE_SETTLE_MS);
        notifier.publish({ runId: "run_1", envId: "env_sharded", tags: ["a"] });

        await vi.waitFor(() => expect(received.some((r) => r.runId === "run_1")).toBe(true), {
          timeout: 5_000,
          interval: 50,
        });
      } finally {
        await notifier.quit();
      }
    }
  );

  describe("ChangeRecord codec", () => {
    it("round-trips a full record (tags with a separator survive)", () => {
      const encoded = encodeChangeRecord({
        v: 1,
        runId: "run_1",
        envId: "env_1",
        tags: ["a", "b,c"],
        batchId: "batch_1",
      });
      expect(decodeChangeRecord(encoded)).toMatchObject({
        v: 1,
        runId: "run_1",
        envId: "env_1",
        tags: ["a", "b,c"],
        batchId: "batch_1",
      });
    });

    it("decodes a bare runId to a partial record (tags undefined)", () => {
      // A bare/legacy frame: the consumer falls back to hydrate-to-classify.
      const decoded = decodeChangeRecord("run_3");
      expect(decoded.runId).toBe("run_3");
      expect(decoded.tags).toBeUndefined();
    });

    it("falls back to a bare runId on an unparseable message", () => {
      expect(decodeChangeRecord("{not json").runId).toBe("{not json");
    });
  });
});
