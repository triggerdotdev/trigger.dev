import { trace } from "@internal/tracing";
import { containerTestWithIsolatedRedis } from "@internal/testcontainers";
import { generateWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { RunEngine } from "../index.js";
import { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";
import { StoreWaitpointCoordinator } from "../waitpointCoordinator/storeWaitpointCoordinator.js";

describe("waitpoint fanout pagination", () => {
  containerTestWithIsolatedRedis(
    "healthy bounded fanout pages survive fenced ack and restart with zero failure attempts",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const createEngine = () =>
        new RunEngine({
          prisma,
          tracer: trace.getTracer("waitpoint-fanout-pagination"),
          logLevel: "error",
          worker: { redis: redisOptions, disabled: true, workers: 1, tasksPerWorker: 1 },
          queue: {
            redis: redisOptions,
            masterQueueConsumersDisabled: true,
            ttlSystem: { disabled: true },
          },
          runLock: { redis: redisOptions },
          machines: {
            defaultMachine: "small-1x",
            machines: {
              "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
            },
            baseCostInCents: 0.0001,
          },
          waitpointStore: store,
          waitpointFanoutStore: store,
          waitpointRouting: { store: new StoreWaitpointCoordinator({ store }) },
          waitpointStoreEnabled: (org) => org === "org",
        });
      let engine = createEngine();
      // This drives the real production handler and the same fenced ack used by RedisWorker.
      const worker = () =>
        (
          engine as unknown as {
            worker: {
              enqueue: (args: any) => Promise<unknown>;
              queue: {
                getJob: (id: string) => Promise<any>;
                ack: (id: string, identity?: string) => Promise<void>;
              };
              jobs: { deliverWaitpointFanout: (args: any) => Promise<void> };
            };
          }
        ).worker;
      try {
        for (const count of [100, 201]) {
          const id = generateWaitpointId("RUN");
          const now = new Date().toISOString();
          await store.createIfAbsent({
            record: {
              id,
              friendlyId: `waitpoint_${id}`,
              type: "RUN",
              environmentId: "env",
              projectId: "project",
              createdAt: now,
              updatedAt: now,
              tags: [],
              userProvidedIdempotencyKey: false,
              completedByTaskRunId: "child",
            },
            status: "PENDING",
          });
          const runs = Array.from({ length: count }, (_, i) => `parent_${count}_${i}`);
          for (const runId of runs)
            await store.registerBlocks({
              runId,
              organizationId: "org",
              blockId: runId,
              edges: [{ waitpointId: id, type: "RUN", createdAt: now }],
            });
          await store.complete({
            waitpointId: id,
            completion: {
              completedAt: now,
              outputType: "application/json",
              outputIsError: false,
              output: null,
            },
          });
          const jobId = `deliverWaitpointFanout:${id}`;
          await worker().enqueue({
            id: jobId,
            job: "deliverWaitpointFanout",
            payload: { waitpointId: id, organizationId: "org" },
            availableAt: new Date(),
          });
          let pages = 0;
          const deadline = performance.now() + 10_000;
          while ((await worker().queue.getJob(jobId)) && performance.now() < deadline) {
            const item = await worker().queue.getJob(jobId);
            expect(item.attempt).toBe(0);
            await worker().jobs.deliverWaitpointFanout({ payload: item.item });
            const replacement = await worker().queue.getJob(jobId);
            if ((await store.describeWaitpoint(id)).outcome === "missing")
              throw new Error("record lost");
            pages++;
            // Simulate death after publishing the next page but before the current ack.
            if (count === 201 && pages === 1) {
              await engine.quit();
              engine = createEngine();
            }
            await worker().queue.ack(jobId, item.deduplicationKey);
            if (pages < Math.ceil(count / 100)) {
              expect(replacement.deduplicationKey).not.toBe(item.deduplicationKey);
              expect((await worker().queue.getJob(jobId)).attempt).toBe(0);
            }
            expect(pages).toBeLessThanOrEqual(Math.ceil(count / 100));
          }
          expect(
            await worker().queue.getJob(jobId),
            "fanout job never drained all pages"
          ).toBeNull();
          expect(pages).toBe(Math.ceil(count / 100));
          const diagnostics = await store.describeWaitpoint(id);
          expect(diagnostics.outcome === "exists" && diagnostics.fanoutFailures).toBe(0);
          for (const runId of runs) {
            expect((await store.readBlockState(runId)).pendingIds).toEqual([]);
            expect(await worker().queue.getJob(`continueRunIfUnblocked:${runId}`)).not.toBeNull();
          }
        }
      } finally {
        await engine.quit();
        await store.quit();
      }
    }
  );
});
