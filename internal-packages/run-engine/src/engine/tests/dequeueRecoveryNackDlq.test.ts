// Reproduction: a run whose queue message is dead-lettered by the dequeue recovery path is left QUEUED (#5106)
// run: cd internal-packages/run-engine && pnpm run test src/engine/tests/dequeueRecoveryNackDlq.test.ts --run
//
// Claim (dequeueSystem.ts, recovery catch, `if (findError || !run || !env)`): when dequeue preparation throws
// and the recovery's run read (runStore.findRun) also fails, the fallback `runQueue.nackMessage(...)` result
// is ignored. On the message's last attempt nackMessage dead-letters it and returns false; the branch above
// (snapshot read failed) turns that false into systemFailure(TASK_RUN_DEQUEUED_MAX_RETRIES), this one does not.
//
// Fault: a wrapper over the real PostgresRunStore whose findRun rejects, once armed, for the two reads that
// select runtimeEnvironmentId (dequeue preparation and the recovery read). Everything else is the real engine,
// Postgres and Redis. The queue retry budget is 1, so the first nack is the last.
// The test asserts the expected behaviour: a run whose message was dead-lettered must not be left QUEUED.
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { PostgresRunStore } from "@internal/run-store";
import { setTimeout } from "timers/promises";
import { describe, expect, vi } from "vitest";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

describe("dequeue recovery nack (#5106)", () => {
  containerTest(
    "a run whose message is dead-lettered by the recovery nack is failed, not left QUEUED",
    async ({ prisma, redisOptions }) => {
      const base = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      let armed = false;
      let injected = 0;
      const store = new Proxy(base, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop === "findRun") {
            return (...args: any[]) => {
              // Dequeue preparation (dequeueRunSelect) and the recovery read both select
              // runtimeEnvironmentId; the snapshot helper's fallback read only selects { id }.
              // The real findRun is async, so a store outage is a rejected promise, never a sync throw.
              if (armed && args[1]?.select?.runtimeEnvironmentId) {
                injected++;
                return Promise.reject(new Error("injected run-store outage"));
              }
              return (value as Function).apply(target, args);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      const engine = new RunEngine({
        prisma,
        store,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: {
          redis: redisOptions,
          retryOptions: { maxAttempts: 1, minTimeoutInMs: 50, maxTimeoutInMs: 50 },
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
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, "test-task");
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_dlq1",
            environment: env,
            taskIdentifier: "test-task",
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t1",
            spanId: "s1",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );
        await setTimeout(500);

        const queued = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(queued);
        expect(queued.snapshot.executionStatus).toBe("QUEUED");

        armed = true;
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "c",
          workerQueue: "main",
        });
        armed = false;
        // Long enough for any retry, requeue or heartbeat on a QUEUED run to have fired.
        await setTimeout(3_000);

        const inDlq = await engine.runQueue.messageInDeadLetterQueue(env, run.id);
        const after = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(after);

        // Preconditions: both reads were hit (so the recovery branch ran) and the message was dead-lettered.
        expect(injected).toBeGreaterThanOrEqual(2);
        expect(dequeued.length).toBe(0);
        expect(inDlq).toBe(true);

        // The claim: nothing records a failure. The expected behaviour is a failed run.
        expect(after.run.status).toBe("SYSTEM_FAILURE");
        expect(after.snapshot.executionStatus).toBe("FINISHED");
      } finally {
        await engine.quit();
      }
    }
  );
});
