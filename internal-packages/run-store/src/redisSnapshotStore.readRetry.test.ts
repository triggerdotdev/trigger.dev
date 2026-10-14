// A read whose reply arrives after the client's command timeout has fired surfaces as an error even
// though the server answered. Reads have no side effects, so the store retries a transient client
// failure a bounded number of times instead of handing the caller a fail-closed error. Writes are
// never retried here: a timed-out write may still have been applied.
import { createRedisClient, type RedisClient, type RedisOptions } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
import { describe, expect, it, vi } from "vitest";
import {
  isTransientRedisClientError,
  RedisSnapshotStore,
  type SnapshotEntryInput,
} from "./redisSnapshotStore.js";

function entry(over: Partial<SnapshotEntryInput> = {}): SnapshotEntryInput {
  return {
    id: "snap_1",
    engine: "V2",
    executionStatus: "RUN_CREATED",
    description: "created",
    runId: "run_1",
    runStatus: "PENDING",
    createdAt: "2026-08-21T00:00:00.000Z",
    environmentId: "env_1",
    environmentType: "PRODUCTION",
    projectId: "proj_1",
    organizationId: "org_1",
    ...over,
  };
}

function commandTimeout(): Error {
  return Object.assign(new Error("Command timed out"), { name: "Error" });
}

function maxRetriesPerRequest(): Error {
  return Object.assign(new Error("Reached the max retries per request limit (which is 20)."), {
    name: "MaxRetriesPerRequestError",
  });
}

// With auto-pipelining on, a call that reaches the real command is re-dispatched through a pipeline
// that copied the spied method, so the spy also records that inner hop. Only calls made on the
// client itself are attempts by the store.
function attempts(spy: { mock: { contexts: unknown[] } }, client: RedisClient): number {
  return spy.mock.contexts.filter((context) => context === client).length;
}

async function withStore(
  redisOptions: RedisOptions,
  fn: (store: RedisSnapshotStore, client: RedisClient) => Promise<void>
) {
  const client = createRedisClient(redisOptions);
  const store = new RedisSnapshotStore({ client, completedTtlMs: 60_000 });
  try {
    await store.append({ entry: entry(), kind: "birth", isTerminal: false });
    await fn(store, client);
  } finally {
    vi.restoreAllMocks();
    await store.quit();
    await client.quit().catch(() => undefined);
  }
}

describe("RedisSnapshotStore read retry", () => {
  redisTest("getLatest returns the head after one command timeout", async ({ redisOptions }) => {
    await withStore(redisOptions, async (store, client) => {
      const spy = vi.spyOn(client, "readLatestSnapshot").mockRejectedValueOnce(commandTimeout());
      const head = await store.getLatest("run_1");
      expect(head?.entry).toMatchObject({ id: "snap_1" });
      expect(attempts(spy, client)).toBe(2);
    });
  });

  redisTest(
    "readPendingState returns after one MaxRetriesPerRequestError",
    async ({ redisOptions }) => {
      await withStore(redisOptions, async (store, client) => {
        const spy = vi
          .spyOn(client, "readPendingState")
          .mockRejectedValueOnce(maxRetriesPerRequest());
        expect(await store.readPendingState("run_1")).toEqual({
          prepared: false,
          quarantined: false,
        });
        expect(attempts(spy, client)).toBe(2);
      });
    }
  );

  redisTest("a non-transient error is not retried", async ({ redisOptions }) => {
    await withStore(redisOptions, async (store, client) => {
      const wrongType = new Error("WRONGTYPE Operation against a key");
      const spy = vi.spyOn(client, "readLatestSnapshot").mockRejectedValueOnce(wrongType);
      await expect(store.getLatest("run_1")).rejects.toBe(wrongType);
      expect(attempts(spy, client)).toBe(1);
    });
  });

  redisTest("three consecutive timeouts reject with the last timeout", async ({ redisOptions }) => {
    await withStore(redisOptions, async (store, client) => {
      const first = commandTimeout();
      const second = commandTimeout();
      const third = commandTimeout();
      const spy = vi
        .spyOn(client, "readLatestSnapshot")
        .mockRejectedValueOnce(first)
        .mockRejectedValueOnce(second)
        .mockRejectedValueOnce(third);
      const started = Date.now();
      await expect(store.getLatest("run_1")).rejects.toBe(third);
      expect(attempts(spy, client)).toBe(3);
      expect(Date.now() - started).toBeLessThan(500);
    });
  });

  redisTest("getById returns the entry after one command timeout", async ({ redisOptions }) => {
    await withStore(redisOptions, async (store, client) => {
      const spy = vi.spyOn(client, "readSnapshotById").mockRejectedValueOnce(commandTimeout());
      const read = await store.getById("run_1", "snap_1");
      expect(read?.entry).toMatchObject({ id: "snap_1" });
      expect(attempts(spy, client)).toBe(2);
    });
  });

  redisTest("getById with retry off rejects on the first timeout", async ({ redisOptions }) => {
    await withStore(redisOptions, async (store, client) => {
      const timeout = commandTimeout();
      const spy = vi.spyOn(client, "readSnapshotById").mockRejectedValueOnce(timeout);
      await expect(store.getById("run_1", "snap_1", { retry: false })).rejects.toBe(timeout);
      expect(attempts(spy, client)).toBe(1);
    });
  });

  redisTest(
    "getSnapshotCompletedWaitpoints with retry off rejects on the first timeout",
    async ({ redisOptions }) => {
      await withStore(redisOptions, async (store, client) => {
        const timeout = commandTimeout();
        const spy = vi
          .spyOn(client, "readSnapshotCompletedWaitpoints")
          .mockRejectedValueOnce(timeout);
        await expect(
          store.getSnapshotCompletedWaitpoints("run_1", "snap_1", { retry: false })
        ).rejects.toBe(timeout);
        expect(attempts(spy, client)).toBe(1);
      });
    }
  );

  redisTest("a write is never retried on a command timeout", async ({ redisOptions }) => {
    await withStore(redisOptions, async (store, client) => {
      const timeout = commandTimeout();
      const spy = vi.spyOn(client, "finalizeSnapshotUnit").mockRejectedValueOnce(timeout);
      await expect(store.finalize("run_1", "tok_1")).rejects.toBe(timeout);
      expect(attempts(spy, client)).toBe(1);
    });
  });
});

describe("isTransientRedisClientError", () => {
  it("treats a command timeout as transient", () => {
    expect(isTransientRedisClientError(commandTimeout())).toBe(true);
  });

  it("treats MaxRetriesPerRequestError as transient", () => {
    expect(isTransientRedisClientError(maxRetriesPerRequest())).toBe(true);
  });

  it("treats a reset or broken-pipe socket as transient", () => {
    expect(
      isTransientRedisClientError(
        Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })
      )
    ).toBe(true);
    expect(
      isTransientRedisClientError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))
    ).toBe(true);
  });

  it("treats a closed connection as transient", () => {
    expect(isTransientRedisClientError(new Error("Connection is closed."))).toBe(true);
  });

  it("does not treat a server reply error as transient", () => {
    expect(isTransientRedisClientError(new Error("WRONGTYPE Operation against a key"))).toBe(false);
  });

  it("does not treat a non-error value as transient", () => {
    expect(isTransientRedisClientError("Command timed out")).toBe(false);
    expect(isTransientRedisClientError(undefined)).toBe(false);
  });
});
