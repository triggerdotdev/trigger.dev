/**
 * The inertness gate: the ordinary application, booted the way production boots it, with
 * store-resident waitpoint minting off.
 *
 * The store coordinator and its fanout worker are exported but nothing in `RunEngine`
 * constructs either one, so a full legacy block-and-complete cycle must leave the Waitpoint
 * namespace completely untouched — no records, no watcher queues, no fanout entries and no
 * partition index — while behaving exactly as it did before. Asserting the keyspace rather
 * than the wiring is deliberate: it fails if a later change starts writing there, however
 * it is introduced.
 */
import { createRedisClient } from "@internal/redis";
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { setTimeout } from "node:timers/promises";
import { expect } from "vitest";
import { FANOUT_PARTITION_COUNT, fanoutIndexKeys } from "../waitpointCoordinator/keys.js";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

describe("Waitpoint fanout stays inert while store-resident minting is disabled", () => {
  containerTest(
    "a legacy block and complete cycle writes nothing into the Waitpoint namespace",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const probe = createRedisClient(redisOptions);

      const engine = new RunEngine({
        prisma,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: {
          redis: redisOptions,
          masterQueueConsumersDisabled: true,
          processWorkerQueueDebounceMs: 50,
        },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: {
            "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
          },
          baseCostInCents: 0.0001,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        // Positive control first: an assertion that can only ever pass is not a guard, so
        // prove the scan finds a `wp:` key when one exists before relying on it finding none.
        await probe.set("wp:{sentinel}", "1");
        expect(await waitpointNamespaceKeys()).toEqual(["wp:{sentinel}"]);
        await probe.del("wp:{sentinel}");
        expect(await waitpointNamespaceKeys()).toEqual([]);

        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_pinert1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t_inert",
            spanId: "s_inert",
            workerQueue: "main",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
          },
          prisma
        );

        await setTimeout(500);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_inert",
          workerQueue: "main",
        });
        await engine.startRunAttempt({
          runId: dequeued[0]!.run.id,
          snapshotId: dequeued[0]!.snapshot.id,
        });

        const created = await engine.createManualWaitpoint({
          environmentId: authenticatedEnvironment.id,
          projectId: authenticatedEnvironment.projectId,
        });

        await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: created.waitpoint.id,
          projectId: authenticatedEnvironment.projectId,
          organizationId: authenticatedEnvironment.organizationId,
        });

        expect(
          (await engine.getRunExecutionData({ runId: run.id }))?.snapshot.executionStatus
        ).toBe("EXECUTING_WITH_WAITPOINTS");
        // Blocked, and the block is recorded where it always was.
        const blocking = await prisma.taskRunWaitpoint.findFirst({ where: { taskRunId: run.id } });
        assertNonNullable(blocking);
        expect(blocking.waitpointId).toBe(created.waitpoint.id);

        // Mid-cycle: a blocked run is exactly when watcher and fanout state would exist.
        expect(await waitpointNamespaceKeys()).toEqual([]);

        await engine.completeWaitpoint({ id: created.waitpoint.id });
        await setTimeout(200);

        // Unchanged legacy behaviour: the run resumes and its block row is gone.
        expect(
          (await engine.getRunExecutionData({ runId: run.id }))?.snapshot.executionStatus
        ).toBe("EXECUTING");
        expect(
          await prisma.taskRunWaitpoint.findFirst({ where: { taskRunId: run.id } })
        ).toBeNull();

        expect(await waitpointNamespaceKeys()).toEqual([]);
        for (let partition = 0; partition < FANOUT_PARTITION_COUNT; partition++) {
          expect(await probe.zcard(fanoutIndexKeys(partition).due)).toBe(0);
          expect(await probe.zcard(fanoutIndexKeys(partition).quarantine)).toBe(0);
        }
      } finally {
        probe.disconnect();
        await engine.quit();
      }

      // The engine's own subsystems use their configured key prefixes, so an unprefixed
      // `wp:` key can only have come from the waitpoint store coordinator.
      async function waitpointNamespaceKeys(): Promise<string[]> {
        const found: string[] = [];
        let cursor = "0";
        do {
          const [next, batch] = await probe.scan(cursor, "MATCH", "wp:*", "COUNT", 1_000);
          found.push(...batch);
          cursor = next;
        } while (cursor !== "0");
        return found.sort();
      }
    }
  );
});
