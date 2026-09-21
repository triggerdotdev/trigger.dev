import { containerTest } from "@internal/testcontainers";
import { MAX_SCHEDULE_PHASE } from "@internal/schedule-engine";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { ScheduleListPresenter } from "~/presenters/v3/ScheduleListPresenter.server";

vi.setConfig({ testTimeout: 60_000 });

async function seedProjectWithEnv(prisma: PrismaClient, slugBase: string) {
  const slug = `${slugBase}_${Math.random().toString(36).slice(2, 10)}`;
  const organization = await prisma.organization.create({
    data: { title: slug, slug },
  });
  const project = await prisma.project.create({
    data: {
      name: slug,
      slug,
      organizationId: organization.id,
      externalRef: slug,
    },
  });
  const prodEnv = await prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${slug}`,
      pkApiKey: `pk_prod_${slug}`,
      shortcode: `p${slug.slice(0, 4)}`,
    },
  });
  return { organization, project, prodEnv };
}

async function seedSchedule(
  prisma: PrismaClient,
  projectId: string,
  environmentId: string,
  opts: {
    friendlyId?: string;
    taskIdentifier?: string;
    type?: "IMPERATIVE" | "DECLARATIVE";
    cron?: string;
    schedulePhase?: number | null;
    active?: boolean;
  } = {}
) {
  const schedule = await prisma.taskSchedule.create({
    data: {
      friendlyId: opts.friendlyId ?? `sched_${Math.random().toString(36).slice(2, 10)}`,
      taskIdentifier: opts.taskIdentifier ?? "my-task",
      projectId,
      generatorExpression: opts.cron ?? "0 * * * *",
      generatorDescription: "every hour",
      type: opts.type ?? "IMPERATIVE",
      active: opts.active ?? true,
    },
  });
  const instance = await prisma.taskScheduleInstance.create({
    data: {
      taskScheduleId: schedule.id,
      environmentId,
      projectId,
      schedulePhase: opts.schedulePhase ?? null,
      active: opts.active ?? true,
    },
  });
  return { schedule, instance };
}

describe("ScheduleListPresenter (imperative schedules visibility without active deployments)", () => {
  containerTest(
    "imperative schedules appear without active worker deployments, with appropriate indicator and phase",
    async ({ prisma }) => {
      const env = await seedProjectWithEnv(prisma, "no_deploy_imperative");

      // Seed an imperative schedule with an explicit schedulePhase
      const imperative = await seedSchedule(prisma, env.project.id, env.prodEnv.id, {
        taskIdentifier: "unversioned-task",
        type: "IMPERATIVE",
        schedulePhase: 4200,
      });

      // Seed a declarative schedule without an active deployment
      await seedSchedule(prisma, env.project.id, env.prodEnv.id, {
        taskIdentifier: "declarative-task",
        type: "DECLARATIVE",
      });

      const presenter = new ScheduleListPresenter(prisma, prisma);
      const result = await presenter.call({
        projectId: env.project.id,
        environmentId: env.prodEnv.id,
      });

      // Imperative schedule is returned despite no BackgroundWorker or WorkerDeployment
      expect(result.totalCount).toBe(1);
      expect(result.schedules).toHaveLength(1);

      const item = result.schedules[0];
      expect(item.id).toBe(imperative.schedule.id);
      expect(item.friendlyId).toBe(imperative.schedule.friendlyId);
      expect(item.taskIdentifier).toBe("unversioned-task");
      // Indicator: schedule type is IMPERATIVE and active is true
      expect(item.type).toBe("IMPERATIVE");
      expect(item.active).toBe(true);
      // Phase: explicit schedulePhase is preserved and effective run times are calculated
      expect(item.schedulePhase).toBe(4200);
      expect(item.nextRun).toBeInstanceOf(Date);
      expect(item.nextRunEffectiveAt).toBeInstanceOf(Date);

      // Declarative schedules are excluded when no active deployment exists
      const declarativeItem = result.schedules.find((s) => s.type === "DECLARATIVE");
      expect(declarativeItem).toBeUndefined();
    }
  );

  containerTest(
    "deterministic schedulePhase is calculated when instance schedulePhase is null",
    async ({ prisma }) => {
      const env = await seedProjectWithEnv(prisma, "null_phase_imperative");

      const imperative = await seedSchedule(prisma, env.project.id, env.prodEnv.id, {
        taskIdentifier: "null-phase-task",
        type: "IMPERATIVE",
        schedulePhase: null,
      });

      const presenter = new ScheduleListPresenter(prisma, prisma);
      const result = await presenter.call({
        projectId: env.project.id,
        environmentId: env.prodEnv.id,
      });

      expect(result.totalCount).toBe(1);
      expect(result.schedules).toHaveLength(1);

      const item = result.schedules[0];
      expect(item.friendlyId).toBe(imperative.schedule.friendlyId);
      expect(item.type).toBe("IMPERATIVE");
      expect(typeof item.schedulePhase).toBe("number");
      expect(item.schedulePhase).toBeGreaterThanOrEqual(0);
      expect(item.schedulePhase).toBeLessThanOrEqual(MAX_SCHEDULE_PHASE);
      expect(item.nextRunEffectiveAt).toBeInstanceOf(Date);
    }
  );

  containerTest(
    "filtering by type=imperative surfaces imperative schedules without deployment",
    async ({ prisma }) => {
      const env = await seedProjectWithEnv(prisma, "filter_imperative");

      await seedSchedule(prisma, env.project.id, env.prodEnv.id, {
        taskIdentifier: "imperative-task",
        type: "IMPERATIVE",
      });
      await seedSchedule(prisma, env.project.id, env.prodEnv.id, {
        taskIdentifier: "declarative-task",
        type: "DECLARATIVE",
      });

      const presenter = new ScheduleListPresenter(prisma, prisma);
      const result = await presenter.call({
        projectId: env.project.id,
        environmentId: env.prodEnv.id,
        type: "imperative",
      });

      expect(result.totalCount).toBe(1);
      expect(result.schedules).toHaveLength(1);
      expect(result.schedules[0].type).toBe("IMPERATIVE");
    }
  );

  containerTest(
    "filtering by type=declarative returns empty when no deployment exists",
    async ({ prisma }) => {
      const env = await seedProjectWithEnv(prisma, "filter_declarative_no_deploy");

      await seedSchedule(prisma, env.project.id, env.prodEnv.id, {
        taskIdentifier: "imperative-task",
        type: "IMPERATIVE",
      });
      await seedSchedule(prisma, env.project.id, env.prodEnv.id, {
        taskIdentifier: "declarative-task",
        type: "DECLARATIVE",
      });

      const presenter = new ScheduleListPresenter(prisma, prisma);
      const result = await presenter.call({
        projectId: env.project.id,
        environmentId: env.prodEnv.id,
        type: "declarative",
      });

      expect(result.totalCount).toBe(0);
      expect(result.schedules).toHaveLength(0);
    }
  );

  containerTest(
    "filtering by taskIdentifier works for imperative schedules without deployment",
    async ({ prisma }) => {
      const env = await seedProjectWithEnv(prisma, "filter_by_task");

      await seedSchedule(prisma, env.project.id, env.prodEnv.id, {
        taskIdentifier: "target-task",
        type: "IMPERATIVE",
      });
      await seedSchedule(prisma, env.project.id, env.prodEnv.id, {
        taskIdentifier: "other-task",
        type: "IMPERATIVE",
      });

      const presenter = new ScheduleListPresenter(prisma, prisma);
      const matching = await presenter.call({
        projectId: env.project.id,
        environmentId: env.prodEnv.id,
        tasks: ["target-task"],
      });
      expect(matching.totalCount).toBe(1);
      expect(matching.schedules[0].taskIdentifier).toBe("target-task");

      const nonMatching = await presenter.call({
        projectId: env.project.id,
        environmentId: env.prodEnv.id,
        tasks: ["nonexistent-task"],
      });
      expect(nonMatching.totalCount).toBe(0);
      expect(nonMatching.schedules).toHaveLength(0);
    }
  );
});
