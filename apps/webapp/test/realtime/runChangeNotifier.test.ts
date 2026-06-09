import { redisTest } from "@internal/testcontainers";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, vi } from "vitest";
import { RunChangeNotifier } from "~/services/realtime/runChangeNotifier.server";

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
    "delivers a published change to a subscriber",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const notifier = new RunChangeNotifier({ redis: toRedisOptions(redisOptions) });
      try {
        const subscription = notifier.subscribeToRunChanges("run_1");
        expect(notifier.activeSubscriptionCount).toBe(1);

        let resolved = false;
        void subscription.changed.then(() => {
          resolved = true;
        });

        await sleep(SUBSCRIBE_SETTLE_MS);
        notifier.publish({ runId: "run_1" });

        await vi.waitFor(() => expect(resolved).toBe(true), { timeout: 5_000, interval: 50 });

        subscription.unsubscribe();
        // Cleanup is deferred until Redis confirms UNSUBSCRIBE (avoids a
        // subscribe/unsubscribe race), so the count converges to 0 asynchronously.
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
    "does not wake a subscriber for a different run",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const notifier = new RunChangeNotifier({ redis: toRedisOptions(redisOptions) });
      try {
        const subscription = notifier.subscribeToRunChanges("run_a");
        let resolved = false;
        void subscription.changed.then(() => {
          resolved = true;
        });

        await sleep(SUBSCRIBE_SETTLE_MS);
        notifier.publish({ runId: "run_b" });
        await sleep(500);

        expect(resolved).toBe(false);
        subscription.unsubscribe();
      } finally {
        await notifier.quit();
      }
    }
  );

  redisTest(
    "refcounts subscriptions per run and wakes all waiters",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const notifier = new RunChangeNotifier({ redis: toRedisOptions(redisOptions) });
      try {
        const first = notifier.subscribeToRunChanges("run_x");
        const second = notifier.subscribeToRunChanges("run_x");

        // Two waiters, one distinct channel.
        expect(notifier.activeSubscriptionCount).toBe(1);

        let firstResolved = false;
        let secondResolved = false;
        void first.changed.then(() => (firstResolved = true));
        void second.changed.then(() => (secondResolved = true));

        await sleep(SUBSCRIBE_SETTLE_MS);
        notifier.publish({ runId: "run_x" });

        await vi.waitFor(() => expect(firstResolved && secondResolved).toBe(true), {
          timeout: 5_000,
          interval: 50,
        });

        // Channel stays until the last waiter unsubscribes. Dropping one waiter only
        // shrinks the listener set (no UNSUBSCRIBE), so the count is still 1 synchronously.
        first.unsubscribe();
        expect(notifier.activeSubscriptionCount).toBe(1);
        // The last unsubscribe issues UNSUBSCRIBE; the channel is dropped once Redis confirms.
        second.unsubscribe();
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
    "publish with no subscribers is a harmless no-op",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const notifier = new RunChangeNotifier({ redis: toRedisOptions(redisOptions) });
      try {
        expect(() => notifier.publish({ runId: "nobody_listening" })).not.toThrow();
      } finally {
        await notifier.quit();
      }
    }
  );

  redisTest(
    "wakes an env subscriber when a run in that env changes (tag-list feed)",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const notifier = new RunChangeNotifier({ redis: toRedisOptions(redisOptions) });
      try {
        const envSub = notifier.subscribeToEnvChanges("env_1");
        let envWoke = false;
        void envSub.changed.then(() => {
          envWoke = true;
        });

        await sleep(SUBSCRIBE_SETTLE_MS);
        // A run change WITH an environmentId fans out to the per-env channel.
        notifier.publish({ runId: "run_1", environmentId: "env_1" });

        await vi.waitFor(() => expect(envWoke).toBe(true), { timeout: 5_000, interval: 50 });
        envSub.unsubscribe();
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
    "does not wake an env subscriber for a different env, nor when env is omitted",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const notifier = new RunChangeNotifier({ redis: toRedisOptions(redisOptions) });
      try {
        const envSub = notifier.subscribeToEnvChanges("env_a");
        let envWoke = false;
        void envSub.changed.then(() => {
          envWoke = true;
        });

        await sleep(SUBSCRIBE_SETTLE_MS);
        notifier.publish({ runId: "run_1", environmentId: "env_b" }); // different env
        notifier.publish({ runId: "run_2" }); // no env -> per-run channel only
        await sleep(500);

        expect(envWoke).toBe(false);
        envSub.unsubscribe();
      } finally {
        await notifier.quit();
      }
    }
  );

  redisTest(
    "re-subscribing right after the last unsubscribe still delivers",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const notifier = new RunChangeNotifier({ redis: toRedisOptions(redisOptions) });
      try {
        const first = notifier.subscribeToRunChanges("run_race");
        await sleep(SUBSCRIBE_SETTLE_MS);

        // Drop the last waiter (issues UNSUBSCRIBE) and immediately re-subscribe before
        // it can settle. The channel must end up subscribed so the new waiter wakes.
        first.unsubscribe();
        const second = notifier.subscribeToRunChanges("run_race");
        let woke = false;
        void second.changed.then(() => {
          woke = true;
        });

        await sleep(SUBSCRIBE_SETTLE_MS);
        notifier.publish({ runId: "run_race" });

        await vi.waitFor(() => expect(woke).toBe(true), { timeout: 5_000, interval: 50 });
        second.unsubscribe();
      } finally {
        await notifier.quit();
      }
    }
  );

  redisTest(
    "coalesces a burst of env publishes into far fewer wakes than publishes",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      // A busy env's run-change firehose must not wake feeds once per publication.
      const notifier = new RunChangeNotifier({
        redis: toRedisOptions(redisOptions),
        envWakeCoalesceWindowMs: 100,
      });
      try {
        // Count wakes by continuously re-subscribing (each subscription is one-shot).
        let wakes = 0;
        let running = true;
        const counter = (async () => {
          while (running) {
            const sub = notifier.subscribeToEnvChanges("env_burst");
            let woke = false;
            void sub.changed.then(() => (woke = true)).catch(() => {});
            const start = Date.now();
            while (!woke && running && Date.now() - start < 1_500) {
              await sleep(5);
            }
            sub.unsubscribe();
            if (woke) wakes++;
            else break;
          }
        })();

        await sleep(SUBSCRIBE_SETTLE_MS);
        // Publish ~200/s for a second to the same env channel.
        let pubs = 0;
        const end = Date.now() + 1_000;
        while (Date.now() < end) {
          notifier.publish({ runId: `r${pubs++}`, environmentId: "env_burst" });
          await sleep(5);
        }
        running = false;
        await counter;

        expect(pubs).toBeGreaterThan(100);
        expect(wakes).toBeGreaterThanOrEqual(1); // leading edge still delivers
        // Leading-edge throttle caps wakes to ~time/window, well below the publish count.
        expect(wakes).toBeLessThan(pubs / 4);
      } finally {
        await notifier.quit();
      }
    }
  );

  // Sharded pub/sub (SSUBSCRIBE/SPUBLISH/smessage) wiring — validated end to end on a
  // single node (Redis 7.2 accepts these commands and delivers same-node). Multi-shard
  // ROUTING needs a real cluster (covered by the cluster fixture), but this proves the
  // notifier's sharded command + event path is correct.
  redisTest(
    "delivers via sharded pub/sub on the per-run channel",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const notifier = new RunChangeNotifier({
        redis: toRedisOptions(redisOptions),
        shardedPubSub: true,
      });
      try {
        const subscription = notifier.subscribeToRunChanges("run_sharded");
        let resolved = false;
        void subscription.changed.then(() => {
          resolved = true;
        });

        await sleep(SUBSCRIBE_SETTLE_MS);
        notifier.publish({ runId: "run_sharded" });

        await vi.waitFor(() => expect(resolved).toBe(true), { timeout: 5_000, interval: 50 });
        subscription.unsubscribe();
      } finally {
        await notifier.quit();
      }
    }
  );

  redisTest(
    "delivers via sharded pub/sub on the per-env channel",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      const notifier = new RunChangeNotifier({
        redis: toRedisOptions(redisOptions),
        shardedPubSub: true,
      });
      try {
        const envSub = notifier.subscribeToEnvChanges("env_sharded");
        let envWoke = false;
        void envSub.changed.then(() => {
          envWoke = true;
        });

        await sleep(SUBSCRIBE_SETTLE_MS);
        notifier.publish({ runId: "run_1", environmentId: "env_sharded" });

        await vi.waitFor(() => expect(envWoke).toBe(true), { timeout: 5_000, interval: 50 });
        envSub.unsubscribe();
      } finally {
        await notifier.quit();
      }
    }
  );
});
