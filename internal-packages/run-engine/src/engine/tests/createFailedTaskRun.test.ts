import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import type { EventBusEventArgs } from "../eventBus.js";
import { setupAuthenticatedEnvironment } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine.createFailedTaskRun", () => {
  containerTest(
    "emits runFailed so the alert pipeline wakes up",
    async ({ prisma, redisOptions }) => {
      // The mollifier drainer (and batch-trigger over-limit path) call
      // createFailedTaskRun to write a terminal SYSTEM_FAILURE PG row
      // for runs that never actually executed. Without an explicit
      // runFailed emit, the row lands silently — the
      // runEngineHandlers' `runFailed` listener (which enqueues
      // PerformTaskRunAlertsService) never fires, so customers'
      // configured TASK_RUN alert channels miss the failure entirely.
      //
      // Regression intent: if the emit is removed or moved out of
      // createFailedTaskRun's success path, this test fails. The
      // shape assertions pin the fields the alert delivery service
      // reads from the event payload (run.id, run.status, error,
      // attemptNumber=0 as the never-ran-marker).
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
          masterQueueConsumersDisabled: true,
          processWorkerQueueDebounceMs: 50,
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
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const failedEvents: EventBusEventArgs<"runFailed">[0][] = [];
        engine.eventBus.on("runFailed", (event) => {
          failedEvents.push(event);
        });

        const friendlyId = generateFriendlyId("run");
        const taskIdentifier = "drainer-terminal-test";

        const failed = await engine.createFailedTaskRun({
          friendlyId,
          environment: {
            id: authenticatedEnvironment.id,
            type: authenticatedEnvironment.type,
            project: { id: authenticatedEnvironment.project.id },
            organization: { id: authenticatedEnvironment.organization.id },
          },
          taskIdentifier,
          payload: "{}",
          payloadType: "application/json",
          error: {
            type: "STRING_ERROR",
            raw: "Mollifier drainer terminal failure: synthetic engine.trigger panic",
          },
          traceId: "0123456789abcdef0123456789abcdef",
          spanId: "fedcba9876543210",
        });

        expect(failed.status).toBe("SYSTEM_FAILURE");

        expect(failedEvents).toHaveLength(1);
        const event = failedEvents[0];
        expect(event.run.id).toBe(failed.id);
        expect(event.run.status).toBe("SYSTEM_FAILURE");
        expect(event.run.spanId).toBe("fedcba9876543210");
        // attemptNumber=0 is the marker that the run never executed —
        // it's a synthesised terminal failure, not an exhausted-retries
        // failure. Downstream consumers can use this to distinguish.
        expect(event.run.attemptNumber).toBe(0);
        expect(event.run.usageDurationMs).toBe(0);
        expect(event.run.costInCents).toBe(0);
        expect(event.run.error).toEqual({
          type: "STRING_ERROR",
          raw: "Mollifier drainer terminal failure: synthetic engine.trigger panic",
        });
        expect(event.organization.id).toBe(authenticatedEnvironment.organization.id);
        expect(event.project.id).toBe(authenticatedEnvironment.project.id);
        expect(event.environment.id).toBe(authenticatedEnvironment.id);
      } finally {
        await engine.quit();
      }
    }
  );

  // The TriggerFailedTaskService.call() path wraps createFailedTaskRun
  // inside `repository.traceEvent({ incomplete: false, isError: true })`
  // which already writes the completion row for the (traceId, spanId).
  // Emitting `runFailed` from here would cause the
  // `completeFailedRunEvent` handler to race a second write against
  // the same span — the `emitRunFailedEvent: false` opt-out is what
  // suppresses the emit. The PG row + alert side stay correct because
  // the caller enqueues `PerformTaskRunAlertsService.enqueue(run.id)`
  // directly after the trace event closes.
  containerTest(
    "emitRunFailedEvent: false suppresses the bus emit but still creates the PG row",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

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
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const failedEvents: EventBusEventArgs<"runFailed">[0][] = [];
        engine.eventBus.on("runFailed", (event) => {
          failedEvents.push(event);
        });

        const friendlyId = generateFriendlyId("run");
        const failed = await engine.createFailedTaskRun({
          friendlyId,
          environment: {
            id: authenticatedEnvironment.id,
            type: authenticatedEnvironment.type,
            project: { id: authenticatedEnvironment.project.id },
            organization: { id: authenticatedEnvironment.organization.id },
          },
          taskIdentifier: "outer-trace-event-test",
          payload: "{}",
          payloadType: "application/json",
          error: { type: "STRING_ERROR", raw: "outer trace event manages span" },
          traceId: "0123456789abcdef0123456789abcdef",
          spanId: "fedcba9876543210",
          emitRunFailedEvent: false,
        });

        // PG row landed (caller still gets a usable TaskRun).
        expect(failed.status).toBe("SYSTEM_FAILURE");
        expect(failed.friendlyId).toBe(friendlyId);

        // Bus emit was suppressed.
        expect(failedEvents).toHaveLength(0);
      } finally {
        await engine.quit();
      }
    }
  );
});
