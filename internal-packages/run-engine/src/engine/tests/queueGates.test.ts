import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { setTimeout } from "timers/promises";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return true;
    }
    await setTimeout(250);
  }
  return condition();
}

describe("RunEngine queue gates", () => {
  containerTest(
    "trigger persists gates and the queue enforces them",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const engine = new RunEngine({
        prisma,
        worker: {
          redis: redisOptions,
          workers: 1,
          tasksPerWorker: 10,
          pollIntervalMs: 100,
        },
        queue: {
          redis: redisOptions,
          processWorkerQueueDebounceMs: 50,
          gatesEnabled: true,
        },
        runLock: {
          redis: redisOptions,
        },
        machines: {
          defaultMachine: "small-1x",
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
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        await engine.runQueue.updateQueueConcurrencyLimits(
          authenticatedEnvironment,
          "shared-gate",
          1
        );

        const run1 = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_g1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t1",
            spanId: "s1",
            workerQueue: "main",
            queue: `task/${taskIdentifier}`,
            gates: [{ queue: "shared-gate" }],
            isTest: false,
            tags: [],
          },
          prisma
        );

        const run2 = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_g2",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t2",
            spanId: "s2",
            workerQueue: "main",
            queue: `task/${taskIdentifier}`,
            gates: [{ queue: "shared-gate" }],
            isTest: false,
            tags: [],
          },
          prisma
        );

        const storedRun = await prisma.taskRun.findFirst({ where: { id: run1.id } });
        expect(storedRun?.gates).toEqual([{ queue: "shared-gate" }]);

        const oneAdmitted = await waitFor(
          async () =>
            (await engine.runQueue.currentConcurrencyOfQueue(
              authenticatedEnvironment,
              "shared-gate"
            )) === 1
        );
        expect(oneAdmitted).toBe(true);

        /** The second run must stay queued behind the full gate. */
        await setTimeout(2000);
        expect(
          await engine.runQueue.currentConcurrencyOfQueue(authenticatedEnvironment, "shared-gate")
        ).toBe(1);
        expect(
          await engine.runQueue.lengthOfQueue(authenticatedEnvironment, `task/${taskIdentifier}`)
        ).toBe(1);
        expect(run2.id).toBeDefined();
      } finally {
        await engine.quit();
      }
    }
  );
});
