// Mode off is the merge-test position: the decorator must be indistinguishable from its delegate and
// must not touch Redis at all. A Redis store whose every member throws proves the second half, and
// enumerating the generated name list proves the first for every method rather than a chosen few.
import { describe, expect, it } from "vitest";
import { RUN_STORE_METHOD_NAMES } from "./runStoreMethodNames.js";
import type { RedisSnapshotStore } from "./redisSnapshotStore.js";
import { TaskRunExecutionSnapshotStore } from "./taskRunExecutionSnapshotStore.js";
import type { RunStore } from "./types.js";

function explodingRedisStore(): RedisSnapshotStore {
  return new Proxy({} as RedisSnapshotStore, {
    get(_target, prop) {
      return () => {
        throw new Error(`the Redis store must not be called at mode off, but ${String(prop)} was`);
      };
    },
  });
}

/**
 * Records what the decorator forwarded, and answers with a per-member sentinel. No database is
 * involved in whether mode off is a pass-through, so none is started; the behavioural suites for
 * every other mode run against a real Postgres and a real Redis.
 */
function forwardingProbe(): { store: RunStore; calls: string[] } {
  const calls: string[] = [];

  const store = new Proxy({} as Record<string, unknown>, {
    get(_target, prop: string) {
      return (...args: unknown[]) => {
        calls.push(prop);
        return `result:${prop}`;
      };
    },
  });

  return { store: store as unknown as RunStore, calls };
}

describe("TaskRunExecutionSnapshotStore at mode off", () => {
  it("defaults to mode off", () => {
    const { store } = forwardingProbe();

    const decorated = new TaskRunExecutionSnapshotStore(store, { store: explodingRedisStore() });

    expect(decorated.mode).toBe("off");
  });

  it("forwards every method to the delegate and never calls Redis", async () => {
    const { store, calls } = forwardingProbe();
    const decorated = new TaskRunExecutionSnapshotStore(store, {
      store: explodingRedisStore(),
      mode: "off",
    }) as unknown as Record<string, (...args: unknown[]) => unknown>;

    for (const name of RUN_STORE_METHOD_NAMES) {
      if (name === "runInTransaction") continue;
      expect(await decorated[name]("arg-one", "arg-two")).toBe(`result:${name}`);
    }

    expect(calls).toEqual(RUN_STORE_METHOD_NAMES.filter((n) => n !== "runInTransaction"));
  });

  it("hands the delegate's own store to a transaction callback", async () => {
    const inner = forwardingProbe().store;
    let seen: unknown;
    const delegate = {
      runInTransaction: async (
        _runId: string | undefined,
        fn: (store: RunStore, tx: unknown) => Promise<void>
      ) => {
        await fn(inner, "tx");
      },
    } as unknown as RunStore;

    const decorated = new TaskRunExecutionSnapshotStore(delegate, {
      store: explodingRedisStore(),
      mode: "off",
    });

    await decorated.runInTransaction("run_1", async (store) => {
      seen = store;
    });

    expect(seen).toBe(inner);
  });

  it("reports every other dial position as one that writes Redis", () => {
    const { store } = forwardingProbe();
    const modes = ["dual-write", "compare", "redis-read", "redis-only"] as const;

    for (const mode of modes) {
      const decorated = new TaskRunExecutionSnapshotStore(store, {
        store: explodingRedisStore(),
        mode,
      });
      expect(decorated.mode).toBe(mode);
    }
  });
});
