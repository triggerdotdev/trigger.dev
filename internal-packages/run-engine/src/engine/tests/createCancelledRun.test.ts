import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { RunId } from "@trigger.dev/core/v3/isomorphic";

function freshRunId() {
  return RunId.generate().friendlyId;
}
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import type { EventBusEventArgs } from "../eventBus.js";
import { setupAuthenticatedEnvironment } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

function baseEngineOptions(redisOptions: Parameters<typeof RunEngine>[0]["queue"]["redis"]) {
  return {
    worker: {
      redis: redisOptions,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
    },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: {
      redis: redisOptions,
    },
    machines: {
      defaultMachine: "small-1x" as const,
      machines: {
        "small-1x": {
          name: "small-1x" as const,
          cpu: 0.5,
          memory: 0.5,
          centsPerMs: 0.0001,
        },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  };
}

// Phase C1 / Q4 design — engine.createCancelledRun writes a CANCELED
// TaskRun row directly from a buffer snapshot. Verifies the bypass-
// queue / bypass-waitpoint / emit-runCancelled contract.
describe("RunEngine.createCancelledRun", () => {
  containerTest(
    "writes CANCELED PG row with snapshot fields, completedAt, error",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = new RunEngine({ prisma, ...baseEngineOptions(redisOptions) });
      try {
        const friendlyId = freshRunId();
        const cancelledAt = new Date("2026-05-20T12:00:00.000Z");
        const cancelReason = "Canceled by user";

        const result = await engine.createCancelledRun({
          snapshot: {
            friendlyId,
            environment: env,
            taskIdentifier: "test-task",
            payload: '{"hello":"world"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "0000000000000000aaaa000000000000",
            spanId: "bbbb000000000000",
            queue: "task/test-task",
            isTest: false,
            tags: ["test-tag"],
          },
          cancelledAt,
          cancelReason,
        });

        expect(result.status).toBe("CANCELED");
        expect(result.friendlyId).toBe(friendlyId);
        expect(result.id).toBe(RunId.fromFriendlyId(friendlyId));
        expect(result.completedAt?.toISOString()).toBe(cancelledAt.toISOString());
        expect(result.taskIdentifier).toBe("test-task");
        expect(result.runTags).toEqual(["test-tag"]);
        expect(result.payload).toBe('{"hello":"world"}');
        const err = result.error as { type?: string; raw?: string };
        expect(err.type).toBe("STRING_ERROR");
        expect(err.raw).toBe(cancelReason);

        // Verify the PG row is canonical (findFirst returns the row).
        const stored = await prisma.taskRun.findFirst({
          where: { friendlyId },
        });
        expect(stored).not.toBeNull();
        expect(stored!.status).toBe("CANCELED");
      } finally {
        await engine.quit();
      }
    },
  );

  containerTest(
    "emits runCancelled with correct payload",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = new RunEngine({ prisma, ...baseEngineOptions(redisOptions) });
      const captured: EventBusEventArgs<"runCancelled">[0][] = [];
      engine.eventBus.on("runCancelled", (event) => {
        captured.push(event);
      });

      try {
        const cancelledAt = new Date();
        const cancelReason = "Test cancel";
        const friendlyId = freshRunId();
        await engine.createCancelledRun({
          snapshot: {
            friendlyId,
            environment: env,
            taskIdentifier: "test-task",
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "0000000000000000cccc000000000000",
            spanId: "dddd000000000000",
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          cancelledAt,
          cancelReason,
        });

        expect(captured).toHaveLength(1);
        expect(captured[0]!.run.status).toBe("CANCELED");
        expect(captured[0]!.run.friendlyId).toBe(friendlyId);
        expect(captured[0]!.run.error).toEqual({ type: "STRING_ERROR", raw: cancelReason });
        expect(captured[0]!.organization.id).toBe(env.organization.id);
      } finally {
        await engine.quit();
      }
    },
  );

  containerTest(
    "idempotent on double-pop: second call returns existing row without re-emitting",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = new RunEngine({ prisma, ...baseEngineOptions(redisOptions) });
      const captured: EventBusEventArgs<"runCancelled">[0][] = [];
      engine.eventBus.on("runCancelled", (event) => {
        captured.push(event);
      });

      try {
        const snapshot = {
          friendlyId: freshRunId(),
          environment: env,
          taskIdentifier: "test-task",
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "0000000000000000eeee000000000000",
          spanId: "ffff000000000000",
          queue: "task/test-task",
          isTest: false,
          tags: [],
        };
        const cancelledAt = new Date();
        const cancelReason = "Test idempotent";

        const first = await engine.createCancelledRun({ snapshot, cancelledAt, cancelReason });
        const second = await engine.createCancelledRun({ snapshot, cancelledAt, cancelReason });

        expect(second.id).toBe(first.id);
        // Only the first call's emit fired; the P2002 path skips re-emission.
        expect(captured).toHaveLength(1);
      } finally {
        await engine.quit();
      }
    },
  );

  // Regression: cjson encodes empty Lua tables as `{}`, not `[]`. When
  // the drainer pops a buffered run that never had a tag set, the
  // deserialised snapshot's `tags` field is an empty object. The old
  // implementation passed it straight into Prisma's `runTags:` field;
  // Prisma misread the object as a relation update op and threw
  // `Argument 'set' is missing`. The drainer caught the error and
  // marked the buffer entry FAILED — so the CANCELED PG row never
  // landed. Found while running the Phase F challenge suite.
  containerTest(
    "tolerates snapshot.tags being an empty object (cjson edge case)",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = new RunEngine({ prisma, ...baseEngineOptions(redisOptions) });
      try {
        const friendlyId = freshRunId();
        // Cast through unknown to simulate the cjson-decode output shape
        // for an empty Lua table — TypeScript's snapshot type says
        // string[], but the buffer Lua delivers {} for the empty case.
        const result = await engine.createCancelledRun({
          snapshot: {
            friendlyId,
            environment: env,
            taskIdentifier: "test-task",
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "0000000000000000abcd000000000000",
            spanId: "1234000000000000",
            queue: "task/test-task",
            isTest: false,
            tags: {} as unknown as string[],
          },
          cancelledAt: new Date(),
          cancelReason: "Cancelled — empty tags",
        });
        expect(result.status).toBe("CANCELED");
        expect(result.friendlyId).toBe(friendlyId);
        // Prisma normalises the absent-tags case to either [] or null
        // depending on the column default; assert it's an empty array.
        expect(result.runTags).toEqual([]);
      } finally {
        await engine.quit();
      }
    },
  );
});
