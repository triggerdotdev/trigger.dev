import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { describe, expect, vi } from "vitest";
import type { TriggerScheduledTaskParams } from "../src/engine/types.js";
import {
  calculateEffectiveScheduleTime,
  calculateNextNominalTimestamp,
  calculateSchedulePhase,
  ScheduleEngine,
} from "../src/index.js";
import { calculateDistributedExecutionTime } from "../src/engine/distributedScheduling.js";

describe("ScheduleEngine Integration (part 2)", () => {
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
        schedulePhaseSecret: "test-schedule-phase-secret",
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

        // Call triggerScheduledTask directly without lastScheduleTime or an
        // effective time, simulating an in-flight Redis job from the old engine.
        const exactScheduleTime = new Date("2026-04-30T10:05:00.000Z");
        await engine.triggerScheduledTask({
          instanceId: scheduleInstance.id,
          finalAttempt: false,
          exactScheduleTime,
          // effectiveScheduleTime and lastScheduleTime intentionally omitted
        });

        expect(triggerCalls.length).toBe(1);
        expect(triggerCalls[0].payload.timestamp).toEqual(exactScheduleTime);
        expect(triggerCalls[0].exactScheduleTime).toEqual(exactScheduleTime);
        expect(triggerCalls[0].effectiveScheduleTime).toEqual(exactScheduleTime);
        // Falls back to instance.lastScheduledTimestamp from the DB rather
        // than reporting undefined for this one transitional fire.
        expect(triggerCalls[0].payload.lastTimestamp).toEqual(preDeployLastFire);

        const nextJob = await engine.getJob(`scheduled-task-instance:${scheduleInstance.id}`);
        const nextJobPayload = nextJob!.item as unknown as {
          exactScheduleTime: string;
          effectiveScheduleTime: string;
        };
        const nextNominalAt = new Date("2026-04-30T10:10:00.000Z");
        const followingNominalAt = new Date("2026-04-30T10:15:00.000Z");
        const schedulePhase = calculateSchedulePhase({
          secret: "test-schedule-phase-secret",
          environmentId: environment.id,
          deduplicationKey: taskSchedule.deduplicationKey,
        });
        const { effectiveAt: nextEffectiveAt } = calculateEffectiveScheduleTime({
          nominalAt: nextNominalAt,
          nextNominalAt: followingNominalAt,
          schedulePhase,
        });

        // The next job advances from the legacy job's nominal T, not from E
        // or the current wall clock, and newly enqueued jobs carry both times.
        expect(new Date(nextJobPayload.exactScheduleTime)).toEqual(nextNominalAt);
        expect(new Date(nextJobPayload.effectiveScheduleTime)).toEqual(nextEffectiveAt);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "should assign a stable schedule phase once when a window is configured",
    { timeout: 30_000 },
    async ({ prisma, redisOptions }) => {
      const schedulePhaseSecret = "test-schedule-phase-secret";
      const triggerCalls: TriggerScheduledTaskParams[] = [];
      const engine = new ScheduleEngine({
        prisma,
        redis: redisOptions,
        distributionWindow: { seconds: 10 },
        schedulePhaseSecret,
        worker: {
          concurrency: 1,
          disabled: true,
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
          data: { title: "Schedule Phase Org", slug: "schedule-phase-org" },
        });
        const project = await prisma.project.create({
          data: {
            name: "Schedule Phase Project",
            slug: "schedule-phase-project",
            externalRef: "schedule-phase-ref",
            organizationId: organization.id,
          },
        });
        const environment = await prisma.runtimeEnvironment.create({
          data: {
            slug: "schedule-phase-env",
            type: "PRODUCTION",
            projectId: project.id,
            organizationId: organization.id,
            apiKey: "tr_schedule_phase",
            pkApiKey: "pk_schedule_phase",
            shortcode: "phase",
          },
        });
        const taskSchedule = await prisma.taskSchedule.create({
          data: {
            friendlyId: "sched_phase",
            taskIdentifier: "schedule-phase-task",
            projectId: project.id,
            deduplicationKey: "schedule-phase-dedup",
            generatorExpression: "*/5 * * * *",
            generatorDescription: "Every 5 minutes",
            timezone: "UTC",
            type: "DECLARATIVE",
          },
        });
        const scheduleInstance = await prisma.taskScheduleInstance.create({
          data: {
            taskScheduleId: taskSchedule.id,
            environmentId: environment.id,
            projectId: project.id,
          },
        });

        await engine.registerNextTaskScheduleInstance({ instanceId: scheduleInstance.id });

        const unwindowedInstance = await prisma.taskScheduleInstance.findUniqueOrThrow({
          where: { id: scheduleInstance.id },
          select: { schedulePhase: true },
        });
        expect(unwindowedInstance.schedulePhase).toBeNull();

        const unwindowedJob = await engine.getJob(`scheduled-task-instance:${scheduleInstance.id}`);
        const unwindowedPayload = unwindowedJob!.item as unknown as {
          exactScheduleTime: string;
          effectiveScheduleTime: string;
        };
        const unwindowedNominalAt = new Date(unwindowedPayload.exactScheduleTime);
        const unwindowedNextNominalAt = calculateNextNominalTimestamp(
          taskSchedule.generatorExpression,
          taskSchedule.timezone,
          unwindowedNominalAt
        );
        const unwindowedPhase = calculateSchedulePhase({
          secret: schedulePhaseSecret,
          environmentId: environment.id,
          deduplicationKey: taskSchedule.deduplicationKey,
        });
        const { effectiveAt: unwindowedEffectiveAt } = calculateEffectiveScheduleTime({
          nominalAt: unwindowedNominalAt,
          nextNominalAt: unwindowedNextNominalAt,
          schedulePhase: unwindowedPhase,
        });
        expect(new Date(unwindowedPayload.effectiveScheduleTime)).toEqual(unwindowedEffectiveAt);
        expect(unwindowedJob!.timestamp).toEqual(
          calculateDistributedExecutionTime(unwindowedEffectiveAt, 10, scheduleInstance.id)
        );

        await prisma.taskSchedule.update({
          where: { id: taskSchedule.id },
          data: { windowDurationSeconds: 60 },
        });

        const expectedPhase = calculateSchedulePhase({
          secret: schedulePhaseSecret,
          environmentId: environment.id,
          deduplicationKey: taskSchedule.deduplicationKey,
        });

        await Promise.all([
          engine.registerNextTaskScheduleInstance({ instanceId: scheduleInstance.id }),
          engine.registerNextTaskScheduleInstance({ instanceId: scheduleInstance.id }),
          engine.registerNextTaskScheduleInstance({ instanceId: scheduleInstance.id }),
        ]);

        const assignedInstance = await prisma.taskScheduleInstance.findUniqueOrThrow({
          where: { id: scheduleInstance.id },
          select: { schedulePhase: true },
        });
        expect(assignedInstance.schedulePhase).toBe(expectedPhase);

        const pinnedPhase = 1_234_567_890;
        await prisma.taskScheduleInstance.update({
          where: { id: scheduleInstance.id },
          data: { schedulePhase: pinnedPhase },
        });

        await engine.registerNextTaskScheduleInstance({ instanceId: scheduleInstance.id });

        const preservedInstance = await prisma.taskScheduleInstance.findUniqueOrThrow({
          where: { id: scheduleInstance.id },
          select: { schedulePhase: true },
        });
        expect(preservedInstance.schedulePhase).toBe(pinnedPhase);

        const exactScheduleTime = new Date("2026-04-30T10:00:00.000Z");
        const effectiveScheduleTime = new Date("2026-04-30T10:00:45.000Z");
        await engine.triggerScheduledTask({
          instanceId: scheduleInstance.id,
          finalAttempt: false,
          exactScheduleTime,
          effectiveScheduleTime,
        });

        expect(triggerCalls).toHaveLength(1);
        expect(triggerCalls[0].payload.timestamp).toEqual(exactScheduleTime);
        expect(triggerCalls[0].exactScheduleTime).toEqual(exactScheduleTime);
        expect(triggerCalls[0].effectiveScheduleTime).toEqual(effectiveScheduleTime);

        const nextJob = await engine.getJob(`scheduled-task-instance:${scheduleInstance.id}`);
        const nextJobPayload = nextJob!.item as unknown as {
          exactScheduleTime: string;
          effectiveScheduleTime: string;
        };
        const nextNominalAt = new Date("2026-04-30T10:05:00.000Z");
        const followingNominalAt = new Date("2026-04-30T10:10:00.000Z");
        const { effectiveAt: nextEffectiveAt } = calculateEffectiveScheduleTime({
          nominalAt: nextNominalAt,
          nextNominalAt: followingNominalAt,
          schedulePhase: pinnedPhase,
          window: { type: "duration", durationSeconds: 60 },
        });

        expect(new Date(nextJobPayload.exactScheduleTime)).toEqual(nextNominalAt);
        expect(new Date(nextJobPayload.effectiveScheduleTime)).toEqual(nextEffectiveAt);
        expect(nextJob!.timestamp).toEqual(
          calculateDistributedExecutionTime(nextEffectiveAt, 10, scheduleInstance.id)
        );
      } finally {
        await engine.quit();
      }
    }
  );
});
