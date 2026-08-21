// Redis-only suite: the coordinator holds no Prisma reference, so no Postgres container
// is needed. redisTest FLUSHALLs before every test, so ids may be reused across describes.
import { createRedisClient, type RedisOptions } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import { WaitpointKeyTagError } from "./keys.js";
import {
  WaitpointNotFoundError,
  WaitpointStoreCoordinator,
  type WaitpointCompletion,
  type WaitpointRecordInput,
} from "./storeCoordinator.js";

const ENV_ID = "env_1";
const PROJECT_ID = "proj_1";
const NOW = "2026-08-21T12:00:00.000Z";

function coordinator(redisOptions: RedisOptions) {
  return new WaitpointStoreCoordinator({ redisOptions });
}

function record(id: string, overrides: Partial<WaitpointRecordInput> = {}): WaitpointRecordInput {
  return {
    id,
    friendlyId: `waitpoint_${id}`,
    type: "MANUAL",
    environmentId: ENV_ID,
    projectId: PROJECT_ID,
    createdAt: NOW,
    updatedAt: NOW,
    userProvidedIdempotencyKey: false,
    tags: [],
    ...overrides,
  };
}

function completion(overrides: Partial<WaitpointCompletion> = {}): WaitpointCompletion {
  return {
    completedAt: NOW,
    outputType: "application/json",
    outputIsError: false,
    output: { inline: '{"ok":true}' },
    ...overrides,
  };
}

describe("createIfAbsent", () => {
  redisTest("creates a PENDING record and reports created", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      const result = await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      expect(result.outcome).toBe("created");
    } finally {
      await store.quit();
    }
  });

  redisTest("returns the existing record on a second call", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      const second = await store.createIfAbsent({
        record: record("w_a", { friendlyId: "waitpoint_DIFFERENT" }),
        status: "PENDING",
      });

      expect(second.outcome).toBe("exists");
      if (second.outcome !== "exists") throw new Error("unreachable");
      // The first write wins: a retry must not overwrite the stored record.
      expect(second.record.friendlyId).toBe("waitpoint_w_a");
      expect(second.status).toBe("PENDING");
      expect(second.completion).toBeUndefined();
    } finally {
      await store.quit();
    }
  });

  redisTest("preserves every record field through a round trip", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      const full = record("w_a", {
        type: "RUN",
        idempotencyKey: "key-1",
        userProvidedIdempotencyKey: true,
        idempotencyKeyExpiresAt: NOW,
        completedAfter: NOW,
        completedByTaskRunId: "run_child",
        completedByBatchId: "batch_1",
        tags: ["one", "two"],
      });

      await store.createIfAbsent({ record: full, status: "PENDING" });
      const read = await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });

      expect(read.outcome).toBe("exists");
      if (read.outcome !== "exists") throw new Error("unreachable");
      // Every field the frozen return shapes need must survive the blob round trip.
      expect(read.record).toEqual(full);
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "can create an already-COMPLETED record with no completion envelope",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        // This is the shape that catches a status-casing mismatch: the record is stored
        // COMPLETED, and a register must see it as completed rather than pending.
        await store.createIfAbsent({ record: record("w_a"), status: "COMPLETED" });

        const reported = await store.registerOrReport({
          waitpointId: "w_a",
          runId: "run_1",
          createdAt: NOW,
        });

        expect(reported.outcome).toBe("completed");
        if (reported.outcome !== "completed") throw new Error("unreachable");
        expect(reported.completion).toBeUndefined();
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "can create an already-COMPLETED record with a completion",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.createIfAbsent({
          record: record("w_a", { type: "RUN" }),
          status: "COMPLETED",
          completion: completion(),
        });

        const reported = await store.registerOrReport({
          waitpointId: "w_a",
          runId: "run_1",
          createdAt: NOW,
        });

        expect(reported.outcome).toBe("completed");
        if (reported.outcome !== "completed") throw new Error("unreachable");
        expect(reported.completion?.output).toEqual({ inline: '{"ok":true}' });
      } finally {
        await store.quit();
      }
    }
  );
});

describe("registerOrReport", () => {
  redisTest("registers a watcher against a PENDING waitpoint", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      const result = await store.registerOrReport({
        waitpointId: "w_a",
        runId: "run_1",
        createdAt: NOW,
      });
      expect(result.outcome).toBe("registered");
    } finally {
      await store.quit();
    }
  });

  redisTest("reports the completion inline for a COMPLETED waitpoint", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      await store.complete({ waitpointId: "w_a", completion: completion() });

      const result = await store.registerOrReport({
        waitpointId: "w_a",
        runId: "run_1",
        createdAt: NOW,
      });

      expect(result.outcome).toBe("completed");
      if (result.outcome !== "completed") throw new Error("unreachable");
      expect(result.completion?.output).toEqual({ inline: '{"ok":true}' });
    } finally {
      await store.quit();
    }
  });

  redisTest("throws for a waitpoint that does not exist", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await expect(
        store.registerOrReport({ waitpointId: "w_missing", runId: "run_1", createdAt: NOW })
      ).rejects.toThrow(WaitpointNotFoundError);
    } finally {
      await store.quit();
    }
  });

  redisTest("keeps one watcher entry per batch index", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      await store.registerOrReport({
        waitpointId: "w_a",
        runId: "run_1",
        batchIndex: 0,
        createdAt: NOW,
      });
      await store.registerOrReport({
        waitpointId: "w_a",
        runId: "run_1",
        batchIndex: 2,
        createdAt: NOW,
      });

      const completed = await store.complete({ waitpointId: "w_a", completion: completion() });
      expect(completed.watchers).toHaveLength(2);
      expect(completed.watchers.map((w) => w.batchIndex).sort()).toEqual([0, 2]);
    } finally {
      await store.quit();
    }
  });

  redisTest("carries spanIdToComplete through to the watcher entry", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      await store.registerOrReport({
        waitpointId: "w_a",
        runId: "run_1",
        spanIdToComplete: "span_abc",
        createdAt: NOW,
      });

      const completed = await store.complete({ waitpointId: "w_a", completion: completion() });
      expect(completed.watchers[0]!.spanIdToComplete).toBe("span_abc");
      expect(completed.watchers[0]!.runId).toBe("run_1");
      expect(completed.watchers[0]!.createdAt).toBe(NOW);
    } finally {
      await store.quit();
    }
  });
});

describe("complete", () => {
  redisTest("flips PENDING to COMPLETED and returns the watchers", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      await store.registerOrReport({ waitpointId: "w_a", runId: "run_1", createdAt: NOW });
      await store.registerOrReport({ waitpointId: "w_a", runId: "run_2", createdAt: NOW });

      const result = await store.complete({ waitpointId: "w_a", completion: completion() });

      expect(result.outcome).toBe("completed");
      expect(result.watchers.map((w) => w.runId).sort()).toEqual(["run_1", "run_2"]);
    } finally {
      await store.quit();
    }
  });

  redisTest("is idempotent and returns the watchers again", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      await store.registerOrReport({ waitpointId: "w_a", runId: "run_1", createdAt: NOW });

      const first = await store.complete({ waitpointId: "w_a", completion: completion() });
      const second = await store.complete({
        waitpointId: "w_a",
        completion: completion({ output: { inline: '{"second":true}' } }),
      });

      expect(first.outcome).toBe("completed");
      expect(second.outcome).toBe("already");
      // The FIRST completion wins, matching the guard on status = PENDING.
      expect(second.completion?.output).toEqual({ inline: '{"ok":true}' });
      expect(second.watchers.map((w) => w.runId)).toEqual(["run_1"]);
    } finally {
      await store.quit();
    }
  });

  redisTest("throws for a waitpoint that does not exist", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await expect(
        store.complete({ waitpointId: "w_missing", completion: completion() })
      ).rejects.toThrow(WaitpointNotFoundError);
    } finally {
      await store.quit();
    }
  });

  redisTest("returns an empty watcher list when nobody is blocked", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      const result = await store.complete({ waitpointId: "w_a", completion: completion() });
      expect(result.watchers).toEqual([]);
    } finally {
      await store.quit();
    }
  });

  redisTest("sets no TTL on the record or the watcher key", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      await store.registerOrReport({ waitpointId: "w_a", runId: "run_1", createdAt: NOW });
      await store.complete({ waitpointId: "w_a", completion: completion() });

      // -1 means the key exists with no expiry. Anything >= 0 breaks the retention rule.
      expect(await probe.pttl("wp:{w_a}")).toBe(-1);
      expect(await probe.pttl("wp:{w_a}:w")).toBe(-1);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });
});

describe("the single-slot guard", () => {
  redisTest("rejects an invocation whose keys span two tags", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      // Reaches the same wrapper every operation goes through, so this proves the guard
      // is live at the call path and not only in the pure unit test.
      expect(() =>
        store.assertKeysForTest("wpComplete", ["wp:{w_a}", "wp:run:{run_1}:pend"])
      ).toThrow(WaitpointKeyTagError);
    } finally {
      await store.quit();
    }
  });
});
