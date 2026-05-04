import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { setTimeout } from "timers/promises";
import { describe, expect, vi } from "vitest";
import { TriggerScheduledTaskParams } from "../src/engine/types.js";
import { ScheduleEngine } from "../src/index.js";

describe("ScheduleEngine Integration", () => {
  containerTest(
    "should process full schedule lifecycle through worker with multiple executions",
    { timeout: 240_000 }, // Increase timeout for multiple executions (4 minutes)
    async ({ prisma, redisOptions }) => {
      // Real callback function for testing expectations
      const mockDevConnectedHandler = vi.fn().mockResolvedValue(true);

      const triggerCalls: Array<{
        params: TriggerScheduledTaskParams;
        executionTime: Date;
      }> = [];

      const engine = new ScheduleEngine({
        prisma,
        redis: redisOptions,
        distributionWindow: { seconds: 10 },
        worker: {
          concurrency: 1,
          disabled: false, // Enable worker for full integration test
          pollIntervalMs: 100, // Poll frequently for faster test execution
        },
        tracer: trace.getTracer("test", "0.0.0"),
        onTriggerScheduledTask: async (params) => {
          const executionTime = new Date(); // Capture when callback is actually called
          console.log(
            `TriggerScheduledTask called at: ${executionTime.toISOString()} (execution #${
              triggerCalls.length + 1
            })`
          );
          console.log("TriggerScheduledTask", params);

          triggerCalls.push({ params, executionTime });
          return { success: true };
        },
        isDevEnvironmentConnectedHandler: mockDevConnectedHandler,
      });

      try {
        // Create real database records
        const organization = await prisma.organization.create({
          data: {
            title: "Test Organization",
            slug: "test-org",
          },
        });

        const project = await prisma.project.create({
          data: {
            name: "Test Project",
            slug: "test-project",
            externalRef: "test-ref",
            organizationId: organization.id,
          },
        });

        const environment = await prisma.runtimeEnvironment.create({
          data: {
            slug: "test-env",
            type: "PRODUCTION",
            projectId: project.id,
            organizationId: organization.id,
            apiKey: "tr_test_1234",
            pkApiKey: "pk_test_1234",
            shortcode: "test-short",
          },
        });

        const taskSchedule = await prisma.taskSchedule.create({
          data: {
            friendlyId: "sched_abc123",
            taskIdentifier: "test-task",
            projectId: project.id,
            deduplicationKey: "test-dedup",
            userProvidedDeduplicationKey: false,
            generatorExpression: "* * * * *", // Every minute
            generatorDescription: "Every minute",
            timezone: "UTC",
            type: "DECLARATIVE",
            active: true,
            externalId: "ext-123",
          },
        });

        const scheduleInstance = await prisma.taskScheduleInstance.create({
          data: {
            taskScheduleId: taskSchedule.id,
            environmentId: environment.id,
            projectId: project.id,
            active: true,
          },
        });

        // Manually enqueue the first scheduled task to kick off the lifecycle.
        // Anchor expectations to the first observed `exactScheduleTime` rather
        // than a precomputed wall-clock value — registration that happens to
        // straddle a minute boundary used to flake tests asserting against a
        // pre-baked "next minute".
        await engine.registerNextTaskScheduleInstance({ instanceId: scheduleInstance.id });

        // Wait for the first execution
        console.log("Waiting for first execution...");
        const startTime = Date.now();
        const maxWaitTime = 70_000; // 70 seconds max wait for first execution

        while (triggerCalls.length === 0 && Date.now() - startTime < maxWaitTime) {
          await setTimeout(100);
        }

        expect(triggerCalls.length).toBeGreaterThanOrEqual(1);

        // Verify the first execution
        const firstExecution = triggerCalls[0];
        console.log("First execution verified, waiting for second execution...");

        // Wait for the second execution (should happen ~1 minute after the first)
        const secondExecutionStartTime = Date.now();
        const maxWaitForSecond = 80_000; // 80 seconds max wait for second execution

        while (
          triggerCalls.length < 2 &&
          Date.now() - secondExecutionStartTime < maxWaitForSecond
        ) {
          await setTimeout(100);
        }

        expect(triggerCalls.length).toBeGreaterThanOrEqual(2);

        const secondExecution = triggerCalls[1];
        console.log("Second execution verified!");

        // Give a small delay for database updates to complete before checking
        await setTimeout(500);

        // Verify both executions have correct timing and distribution window behavior
        for (let i = 0; i < 2; i++) {
          const execution = triggerCalls[i];
          const expectedScheduleTime = execution.params.exactScheduleTime;

          if (expectedScheduleTime) {
            // Calculate the distribution window (10 seconds before the scheduled time)
            const distributionWindowStart = new Date(expectedScheduleTime);
            distributionWindowStart.setSeconds(distributionWindowStart.getSeconds() - 10);

            console.log(`Execution ${i + 1}:`);
            console.log("  Scheduled time:", expectedScheduleTime.toISOString());
            console.log("  Distribution window start:", distributionWindowStart.toISOString());
            console.log("  Actual execution time:", execution.executionTime.toISOString());

            // Verify the callback was executed within the distribution window
            expect(execution.executionTime.getTime()).toBeGreaterThanOrEqual(
              distributionWindowStart.getTime()
            );
            expect(execution.executionTime.getTime()).toBeLessThanOrEqual(
              expectedScheduleTime.getTime()
            );
          }
        }

        // Anchor all expectations to what the engine actually fired with, so
        // the test stays deterministic regardless of when within a minute it
        // started.
        const firstScheduledTime = firstExecution.params.exactScheduleTime;
        const secondScheduledTime = secondExecution.params.exactScheduleTime;
        expect(firstScheduledTime).toBeDefined();
        expect(secondScheduledTime).toBeDefined();

        // Each cron slot for "* * * * *" is exactly 60s apart.
        expect(secondScheduledTime!.getTime() - firstScheduledTime!.getTime()).toBe(60_000);

        // Verify the first execution parameters
        expect(firstExecution.params).toEqual({
          taskIdentifier: "test-task",
          environment: expect.objectContaining({
            id: environment.id,
            type: "PRODUCTION",
            project: expect.objectContaining({
              id: project.id,
              name: "Test Project",
              slug: "test-project",
            }),
            organization: expect.objectContaining({
              id: organization.id,
              title: "Test Organization",
              slug: "test-org",
            }),
          }),
          payload: {
            scheduleId: "sched_abc123",
            type: "DECLARATIVE",
            timestamp: firstScheduledTime,
            // First-ever fire: no `lastScheduleTime` carried in the worker
            // payload and `instance.lastScheduledTimestamp` is null on a
            // fresh instance, so lastTimestamp is undefined. This preserves
            // the `if (!payload.lastTimestamp)` first-run sentinel customers
            // rely on.
            lastTimestamp: undefined,
            externalId: "ext-123",
            timezone: "UTC",
            upcoming: expect.arrayContaining([expect.any(Date)]),
          },
          scheduleInstanceId: scheduleInstance.id,
          scheduleId: taskSchedule.id,
          exactScheduleTime: firstScheduledTime,
        });

        // Verify the second execution parameters
        expect(secondExecution.params).toEqual({
          taskIdentifier: "test-task",
          environment: expect.objectContaining({
            id: environment.id,
            type: "PRODUCTION",
          }),
          payload: {
            scheduleId: "sched_abc123",
            type: "DECLARATIVE",
            timestamp: secondScheduledTime,
            // The previous fire's exactScheduleTime is carried through the
            // worker payload as `lastScheduleTime` and surfaced here.
            lastTimestamp: firstScheduledTime,
            externalId: "ext-123",
            timezone: "UTC",
            upcoming: expect.arrayContaining([expect.any(Date)]),
          },
          scheduleInstanceId: scheduleInstance.id,
          scheduleId: taskSchedule.id,
          exactScheduleTime: secondScheduledTime,
        });
      } finally {
        // Clean up: stop the worker
        await engine.quit();
      }
    }
  );

  // Deploy-moment backward compatibility. At deploy time, in-flight Redis jobs
  // were enqueued by the old engine — their payload has no `lastScheduleTime`
  // field — and `instance.lastScheduledTimestamp` is still populated (last
  // written by the old engine pre-deploy). The new engine must report that DB
  // value as `payload.lastTimestamp` so customers don't see a transient
  // `undefined` for the one fire per schedule that drains the legacy queue.
  containerTest(
    "should fall back to instance.lastScheduledTimestamp when payload lacks lastScheduleTime",
    { timeout: 30_000 },
    async ({ prisma, redisOptions }) => {
      const triggerCalls: TriggerScheduledTaskParams[] = [];
      const engine = new ScheduleEngine({
        prisma,
        redis: redisOptions,
        distributionWindow: { seconds: 10 },
        worker: {
          concurrency: 1,
          disabled: true, // Don't actually run the worker — calling triggerScheduledTask directly
          pollIntervalMs: 1000,
        },
        tracer: trace.getTracer("test", "0.0.0"),
        onTriggerScheduledTask: async (params) => {
          triggerCalls.push(params);
          return { success: true };
        },
        isDevEnvironmentConnectedHandler: vi.fn().mockResolvedValue(true),
      });

      try {
        const organization = await prisma.organization.create({
          data: { title: "Legacy Payload Org", slug: "legacy-payload-org" },
        });

        const project = await prisma.project.create({
          data: {
            name: "Legacy Payload Project",
            slug: "legacy-payload-project",
            externalRef: "legacy-payload-ref",
            organizationId: organization.id,
          },
        });

        const environment = await prisma.runtimeEnvironment.create({
          data: {
            slug: "legacy-payload-env",
            type: "PRODUCTION",
            projectId: project.id,
            organizationId: organization.id,
            apiKey: "tr_legacy_1234",
            pkApiKey: "pk_legacy_1234",
            shortcode: "legacy-short",
          },
        });

        const taskSchedule = await prisma.taskSchedule.create({
          data: {
            friendlyId: "sched_legacy_payload",
            taskIdentifier: "legacy-payload-task",
            projectId: project.id,
            deduplicationKey: "legacy-payload-dedup",
            userProvidedDeduplicationKey: false,
            generatorExpression: "*/5 * * * *",
            generatorDescription: "Every 5 minutes",
            timezone: "UTC",
            type: "DECLARATIVE",
            active: true,
            externalId: "legacy-ext",
          },
        });

        // Pre-populate lastScheduledTimestamp on the instance — simulates the
        // value the old engine wrote to the DB before this PR deployed.
        const preDeployLastFire = new Date("2026-04-30T10:00:00.000Z");
        const scheduleInstance = await prisma.taskScheduleInstance.create({
          data: {
            taskScheduleId: taskSchedule.id,
            environmentId: environment.id,
            projectId: project.id,
            active: true,
            lastScheduledTimestamp: preDeployLastFire,
          },
        });

        // Call triggerScheduledTask directly without lastScheduleTime,
        // simulating an in-flight Redis job enqueued by the old engine.
        const exactScheduleTime = new Date("2026-04-30T10:05:00.000Z");
        await engine.triggerScheduledTask({
          instanceId: scheduleInstance.id,
          finalAttempt: false,
          exactScheduleTime,
          // lastScheduleTime intentionally omitted — legacy payload shape
        });

        expect(triggerCalls.length).toBe(1);
        expect(triggerCalls[0].payload.timestamp).toEqual(exactScheduleTime);
        // Falls back to instance.lastScheduledTimestamp from the DB rather
        // than reporting undefined for this one transitional fire.
        expect(triggerCalls[0].payload.lastTimestamp).toEqual(preDeployLastFire);
      } finally {
        await engine.quit();
      }
    }
  );
});
