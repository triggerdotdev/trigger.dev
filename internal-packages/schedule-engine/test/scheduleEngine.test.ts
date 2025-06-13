import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { describe, expect, vi } from "vitest";
import { ScheduleEngine } from "../src/index.js";
import { setTimeout } from "timers/promises";
import { TriggerScheduledTaskParams } from "../src/engine/types.js";

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
            active: true,
          },
        });

        // Calculate the expected next execution time (next minute boundary)
        const now = new Date();
        const expectedExecutionTime = new Date(now);
        expectedExecutionTime.setMinutes(now.getMinutes() + 1, 0, 0); // Next minute, 0 seconds, 0 milliseconds

        // Calculate the expected upcoming execution times (next 10 minutes after the first execution)
        const expectedUpcoming = [];
        for (let i = 1; i <= 10; i++) {
          const upcoming = new Date(expectedExecutionTime);
          upcoming.setMinutes(expectedExecutionTime.getMinutes() + i);
          expectedUpcoming.push(upcoming);
        }

        // Manually enqueue the first scheduled task to kick off the lifecycle
        await engine.registerNextTaskScheduleInstance({ instanceId: scheduleInstance.id });

        // Get the actual nextScheduledTimestamp that was calculated by the engine
        const instanceAfterRegistration = await prisma.taskScheduleInstance.findFirst({
          where: { id: scheduleInstance.id },
        });
        const actualNextExecution = instanceAfterRegistration?.nextScheduledTimestamp;
        expect(actualNextExecution).toBeDefined();
        expect(actualNextExecution).toEqual(expectedExecutionTime);

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
            timestamp: actualNextExecution,
            lastTimestamp: undefined, // First run has no lastTimestamp
            externalId: "ext-123",
            timezone: "UTC",
            upcoming: expect.arrayContaining([expect.any(Date)]),
          },
          scheduleInstanceId: scheduleInstance.id,
          scheduleId: taskSchedule.id,
          exactScheduleTime: actualNextExecution,
        });

        // Verify the second execution parameters
        if (actualNextExecution) {
          const expectedSecondExecution = new Date(actualNextExecution);
          expectedSecondExecution.setMinutes(actualNextExecution.getMinutes() + 1);

          expect(secondExecution.params).toEqual({
            taskIdentifier: "test-task",
            environment: expect.objectContaining({
              id: environment.id,
              type: "PRODUCTION",
            }),
            payload: {
              scheduleId: "sched_abc123",
              type: "DECLARATIVE",
              timestamp: expectedSecondExecution,
              lastTimestamp: actualNextExecution, // Second run should have the first execution time as lastTimestamp
              externalId: "ext-123",
              timezone: "UTC",
              upcoming: expect.arrayContaining([expect.any(Date)]),
            },
            scheduleInstanceId: scheduleInstance.id,
            scheduleId: taskSchedule.id,
            exactScheduleTime: expectedSecondExecution,
          });
        }

        // Verify database updates occurred after both executions
        const updatedSchedule = await prisma.taskSchedule.findFirst({
          where: { id: taskSchedule.id },
        });
        expect(updatedSchedule?.lastRunTriggeredAt).toBeTruthy();
        expect(updatedSchedule?.lastRunTriggeredAt).toBeInstanceOf(Date);

        const finalInstance = await prisma.taskScheduleInstance.findFirst({
          where: { id: scheduleInstance.id },
        });

        // After two executions, lastScheduledTimestamp should be the second execution time
        if (actualNextExecution && secondExecution.params.exactScheduleTime) {
          const secondExecutionTime = secondExecution.params.exactScheduleTime;
          expect(finalInstance?.lastScheduledTimestamp).toEqual(secondExecutionTime);

          // The next scheduled timestamp should be 1 minute after the second execution
          const expectedThirdExecution = new Date(secondExecutionTime);
          expectedThirdExecution.setMinutes(secondExecutionTime.getMinutes() + 1);
          expect(finalInstance?.nextScheduledTimestamp).toEqual(expectedThirdExecution);
        }
      } finally {
        // Clean up: stop the worker
        await engine.quit();
      }
    }
  );
});
