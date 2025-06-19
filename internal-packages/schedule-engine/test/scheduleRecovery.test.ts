import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { describe, expect, vi } from "vitest";
import { TriggerScheduledTaskParams } from "../src/engine/types.js";
import { ScheduleEngine } from "../src/index.js";

describe("Schedule Recovery", () => {
  containerTest(
    "should recover schedules when no existing jobs are found",
    { timeout: 30_000 },
    async ({ prisma, redisOptions }) => {
      const mockDevConnectedHandler = vi.fn().mockResolvedValue(true);
      const triggerCalls: TriggerScheduledTaskParams[] = [];

      const engine = new ScheduleEngine({
        prisma,
        redis: redisOptions,
        distributionWindow: { seconds: 10 },
        worker: {
          concurrency: 1,
          disabled: true, // Disable worker to prevent automatic execution
          pollIntervalMs: 1000,
        },
        tracer: trace.getTracer("test", "0.0.0"),
        onTriggerScheduledTask: async (params) => {
          triggerCalls.push(params);
          return { success: true };
        },
        isDevEnvironmentConnectedHandler: mockDevConnectedHandler,
      });

      try {
        // Create test data
        const organization = await prisma.organization.create({
          data: {
            title: "Recovery Test Org",
            slug: "recovery-test-org",
          },
        });

        const project = await prisma.project.create({
          data: {
            name: "Recovery Test Project",
            slug: "recovery-test-project",
            externalRef: "recovery-test-ref",
            organizationId: organization.id,
          },
        });

        const environment = await prisma.runtimeEnvironment.create({
          data: {
            slug: "recovery-test-env",
            type: "PRODUCTION",
            projectId: project.id,
            organizationId: organization.id,
            apiKey: "tr_recovery_test_1234",
            pkApiKey: "pk_recovery_test_1234",
            shortcode: "recovery-test-short",
          },
        });

        const taskSchedule = await prisma.taskSchedule.create({
          data: {
            friendlyId: "sched_recovery_123",
            taskIdentifier: "recovery-test-task",
            projectId: project.id,
            deduplicationKey: "recovery-test-dedup",
            userProvidedDeduplicationKey: false,
            generatorExpression: "0 */5 * * *", // Every 5 minutes
            generatorDescription: "Every 5 minutes",
            timezone: "UTC",
            type: "DECLARATIVE",
            active: true,
            externalId: "recovery-ext-123",
          },
        });

        const scheduleInstance = await prisma.taskScheduleInstance.create({
          data: {
            taskScheduleId: taskSchedule.id,
            environmentId: environment.id,
            active: true,
          },
        });

        // Verify no job exists initially
        const jobBeforeRecovery = await engine.getJob(
          `scheduled-task-instance:${scheduleInstance.id}`
        );
        expect(jobBeforeRecovery).toBeNull();

        // Perform recovery
        await engine.recoverSchedulesInEnvironment(project.id, environment.id);

        // Verify that a job was created
        const jobAfterRecovery = await engine.getJob(
          `scheduled-task-instance:${scheduleInstance.id}`
        );
        expect(jobAfterRecovery).not.toBeNull();
        expect(jobAfterRecovery?.job).toBe("schedule.triggerScheduledTask");

        // Verify the instance was updated with next scheduled timestamp
        const updatedInstance = await prisma.taskScheduleInstance.findFirst({
          where: { id: scheduleInstance.id },
        });
        expect(updatedInstance?.nextScheduledTimestamp).toBeDefined();
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "should not create duplicate jobs when schedule already has an active job",
    { timeout: 30_000 },
    async ({ prisma, redisOptions }) => {
      const mockDevConnectedHandler = vi.fn().mockResolvedValue(true);
      const triggerCalls: TriggerScheduledTaskParams[] = [];

      const engine = new ScheduleEngine({
        prisma,
        redis: redisOptions,
        distributionWindow: { seconds: 10 },
        worker: {
          concurrency: 1,
          disabled: true, // Disable worker to prevent automatic execution
          pollIntervalMs: 1000,
        },
        tracer: trace.getTracer("test", "0.0.0"),
        onTriggerScheduledTask: async (params) => {
          triggerCalls.push(params);
          return { success: true };
        },
        isDevEnvironmentConnectedHandler: mockDevConnectedHandler,
      });

      try {
        // Create test data
        const organization = await prisma.organization.create({
          data: {
            title: "Duplicate Test Org",
            slug: "duplicate-test-org",
          },
        });

        const project = await prisma.project.create({
          data: {
            name: "Duplicate Test Project",
            slug: "duplicate-test-project",
            externalRef: "duplicate-test-ref",
            organizationId: organization.id,
          },
        });

        const environment = await prisma.runtimeEnvironment.create({
          data: {
            slug: "duplicate-test-env",
            type: "PRODUCTION",
            projectId: project.id,
            organizationId: organization.id,
            apiKey: "tr_duplicate_test_1234",
            pkApiKey: "pk_duplicate_test_1234",
            shortcode: "duplicate-test-short",
          },
        });

        const taskSchedule = await prisma.taskSchedule.create({
          data: {
            friendlyId: "sched_duplicate_123",
            taskIdentifier: "duplicate-test-task",
            projectId: project.id,
            deduplicationKey: "duplicate-test-dedup",
            userProvidedDeduplicationKey: false,
            generatorExpression: "0 */10 * * *", // Every 10 minutes
            generatorDescription: "Every 10 minutes",
            timezone: "UTC",
            type: "DECLARATIVE",
            active: true,
            externalId: "duplicate-ext-123",
          },
        });

        const scheduleInstance = await prisma.taskScheduleInstance.create({
          data: {
            taskScheduleId: taskSchedule.id,
            environmentId: environment.id,
            active: true,
          },
        });

        // First, register the schedule normally
        await engine.registerNextTaskScheduleInstance({ instanceId: scheduleInstance.id });

        // Verify job exists
        const jobAfterFirstRegistration = await engine.getJob(
          `scheduled-task-instance:${scheduleInstance.id}`
        );
        expect(jobAfterFirstRegistration).not.toBeNull();
        const firstJobId = jobAfterFirstRegistration?.id;

        // Now run recovery - it should not create a duplicate job
        await engine.recoverSchedulesInEnvironment(project.id, environment.id);

        // Verify the same job still exists (no duplicate created)
        const jobAfterRecovery = await engine.getJob(
          `scheduled-task-instance:${scheduleInstance.id}`
        );
        expect(jobAfterRecovery).not.toBeNull();
        expect(jobAfterRecovery?.id).toBe(firstJobId);
        expect(jobAfterRecovery?.deduplicationKey).toBe(taskSchedule.deduplicationKey);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "should recover multiple schedules in the same environment",
    { timeout: 30_000 },
    async ({ prisma, redisOptions }) => {
      const mockDevConnectedHandler = vi.fn().mockResolvedValue(true);
      const triggerCalls: TriggerScheduledTaskParams[] = [];

      const engine = new ScheduleEngine({
        prisma,
        redis: redisOptions,
        distributionWindow: { seconds: 10 },
        worker: {
          concurrency: 1,
          disabled: true, // Disable worker to prevent automatic execution
          pollIntervalMs: 1000,
        },
        tracer: trace.getTracer("test", "0.0.0"),
        onTriggerScheduledTask: async (params) => {
          triggerCalls.push(params);
          return { success: true };
        },
        isDevEnvironmentConnectedHandler: mockDevConnectedHandler,
      });

      try {
        // Create test data
        const organization = await prisma.organization.create({
          data: {
            title: "Multiple Test Org",
            slug: "multiple-test-org",
          },
        });

        const project = await prisma.project.create({
          data: {
            name: "Multiple Test Project",
            slug: "multiple-test-project",
            externalRef: "multiple-test-ref",
            organizationId: organization.id,
          },
        });

        const environment = await prisma.runtimeEnvironment.create({
          data: {
            slug: "multiple-test-env",
            type: "PRODUCTION",
            projectId: project.id,
            organizationId: organization.id,
            apiKey: "tr_multiple_test_1234",
            pkApiKey: "pk_multiple_test_1234",
            shortcode: "multiple-test-short",
          },
        });

        // Create multiple task schedules
        const schedules = [];
        const instances = [];

        for (let i = 1; i <= 3; i++) {
          const taskSchedule = await prisma.taskSchedule.create({
            data: {
              friendlyId: `sched_multiple_${i}`,
              taskIdentifier: `multiple-test-task-${i}`,
              projectId: project.id,
              deduplicationKey: `multiple-test-dedup-${i}`,
              userProvidedDeduplicationKey: false,
              generatorExpression: `${i} */15 * * *`, // Every 15 minutes at different minute offsets
              generatorDescription: `Every 15 minutes (${i})`,
              timezone: "UTC",
              type: "DECLARATIVE",
              active: true,
              externalId: `multiple-ext-${i}`,
            },
          });

          const scheduleInstance = await prisma.taskScheduleInstance.create({
            data: {
              taskScheduleId: taskSchedule.id,
              environmentId: environment.id,
              active: true,
            },
          });

          schedules.push(taskSchedule);
          instances.push(scheduleInstance);
        }

        // Verify no jobs exist initially
        for (const instance of instances) {
          const job = await engine.getJob(`scheduled-task-instance:${instance.id}`);
          expect(job).toBeNull();
        }

        // Perform recovery
        await engine.recoverSchedulesInEnvironment(project.id, environment.id);

        // Verify that jobs were created for all instances
        for (const instance of instances) {
          const job = await engine.getJob(`scheduled-task-instance:${instance.id}`);
          expect(job).not.toBeNull();
          expect(job?.job).toBe("schedule.triggerScheduledTask");
        }

        // Verify all instances were updated
        for (const instance of instances) {
          const updatedInstance = await prisma.taskScheduleInstance.findFirst({
            where: { id: instance.id },
          });
          expect(updatedInstance?.nextScheduledTimestamp).toBeDefined();
        }
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "should handle recovery gracefully when no schedules exist in environment",
    { timeout: 30_000 },
    async ({ prisma, redisOptions }) => {
      const mockDevConnectedHandler = vi.fn().mockResolvedValue(true);
      const triggerCalls: TriggerScheduledTaskParams[] = [];

      const engine = new ScheduleEngine({
        prisma,
        redis: redisOptions,
        distributionWindow: { seconds: 10 },
        worker: {
          concurrency: 1,
          disabled: true, // Disable worker to prevent automatic execution
          pollIntervalMs: 1000,
        },
        tracer: trace.getTracer("test", "0.0.0"),
        onTriggerScheduledTask: async (params) => {
          triggerCalls.push(params);
          return { success: true };
        },
        isDevEnvironmentConnectedHandler: mockDevConnectedHandler,
      });

      try {
        // Create test data but no schedules
        const organization = await prisma.organization.create({
          data: {
            title: "Empty Test Org",
            slug: "empty-test-org",
          },
        });

        const project = await prisma.project.create({
          data: {
            name: "Empty Test Project",
            slug: "empty-test-project",
            externalRef: "empty-test-ref",
            organizationId: organization.id,
          },
        });

        const environment = await prisma.runtimeEnvironment.create({
          data: {
            slug: "empty-test-env",
            type: "PRODUCTION",
            projectId: project.id,
            organizationId: organization.id,
            apiKey: "tr_empty_test_1234",
            pkApiKey: "pk_empty_test_1234",
            shortcode: "empty-test-short",
          },
        });

        // Perform recovery on empty environment - should not throw errors
        await expect(
          engine.recoverSchedulesInEnvironment(project.id, environment.id)
        ).resolves.not.toThrow();
      } finally {
        await engine.quit();
      }
    }
  );
});
