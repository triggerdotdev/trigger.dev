import { describe, expect, vi } from "vitest";

// Mock the db prisma client
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

import { replicationContainerTest } from "@internal/testcontainers";
import { setTimeout } from "node:timers/promises";
import { RunsRepository } from "~/services/runsRepository/runsRepository.server";
import { setupClickhouseReplication } from "./utils/replicationUtils";

vi.setConfig({ testTimeout: 60_000 });

describe("RunsRepository (part 3/4)", () => {
  replicationContainerTest(
    "should filter runs by tags",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      const organization = await prisma.organization.create({
        data: {
          title: "test",
          slug: "test",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test",
          slug: "test",
          organizationId: organization.id,
          externalRef: "test",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test",
          pkApiKey: "test",
          shortcode: "test",
        },
      });

      // Create runs with different tags
      const _taskRun1 = await prisma.taskRun.create({
        data: {
          friendlyId: "run_urgent",
          taskIdentifier: "my-task",
          runTags: ["urgent", "production"],
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      const _taskRun2 = await prisma.taskRun.create({
        data: {
          friendlyId: "run_regular",
          taskIdentifier: "my-task",
          runTags: ["regular", "development"],
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1235",
          spanId: "1235",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      const _taskRun3 = await prisma.taskRun.create({
        data: {
          friendlyId: "run_urgent_dev",
          taskIdentifier: "my-task",
          runTags: ["urgent", "development"],
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1236",
          spanId: "1236",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      await setTimeout(1000);

      const runsRepository = new RunsRepository({
        prisma,
        clickhouse,
      });

      // Test filtering by tags
      const { runs } = await runsRepository.listRuns({
        page: { size: 10 },
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
        tags: ["urgent"],
      });

      expect(runs).toHaveLength(2);
      expect(runs.map((r) => r.friendlyId).sort()).toEqual(["run_urgent", "run_urgent_dev"]);
    }
  );

  replicationContainerTest(
    "should filter runs by scheduleId",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      const organization = await prisma.organization.create({
        data: {
          title: "test",
          slug: "test",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test",
          slug: "test",
          organizationId: organization.id,
          externalRef: "test",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test",
          pkApiKey: "test",
          shortcode: "test",
        },
      });

      // Create runs with different schedule IDs
      await prisma.taskRun.create({
        data: {
          friendlyId: "run_scheduled_1",
          taskIdentifier: "my-task",
          scheduleId: "schedule_1",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      await prisma.taskRun.create({
        data: {
          friendlyId: "run_scheduled_2",
          taskIdentifier: "my-task",
          scheduleId: "schedule_2",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1235",
          spanId: "1235",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      await prisma.taskRun.create({
        data: {
          friendlyId: "run_unscheduled",
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1236",
          spanId: "1236",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      await setTimeout(1000);

      const runsRepository = new RunsRepository({
        prisma,
        clickhouse,
      });

      // Test filtering by schedule ID
      const { runs } = await runsRepository.listRuns({
        page: { size: 10 },
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
        scheduleId: "schedule_1",
      });

      expect(runs).toHaveLength(1);
      expect(runs[0].friendlyId).toBe("run_scheduled_1");
    }
  );

  replicationContainerTest(
    "should filter runs by isTest flag",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      const organization = await prisma.organization.create({
        data: {
          title: "test",
          slug: "test",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test",
          slug: "test",
          organizationId: organization.id,
          externalRef: "test",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test",
          pkApiKey: "test",
          shortcode: "test",
        },
      });

      // Create test and non-test runs
      await prisma.taskRun.create({
        data: {
          friendlyId: "run_test",
          taskIdentifier: "my-task",
          isTest: true,
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      await prisma.taskRun.create({
        data: {
          friendlyId: "run_production",
          taskIdentifier: "my-task",
          isTest: false,
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1235",
          spanId: "1235",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      await setTimeout(1000);

      const runsRepository = new RunsRepository({
        prisma,
        clickhouse,
      });

      // Test filtering by isTest=true
      const testRuns = await runsRepository.listRuns({
        page: { size: 10 },
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
        isTest: true,
      });

      expect(testRuns.runs).toHaveLength(1);
      expect(testRuns.runs[0].friendlyId).toBe("run_test");

      // Test filtering by isTest=false
      const productionRuns = await runsRepository.listRuns({
        page: { size: 10 },
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
        isTest: false,
      });

      expect(productionRuns.runs).toHaveLength(1);
      expect(productionRuns.runs[0].friendlyId).toBe("run_production");
    }
  );

  replicationContainerTest(
    "should filter runs by completion time with filterByCompletedAt",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      const organization = await prisma.organization.create({
        data: {
          title: "test",
          slug: "test",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test",
          slug: "test",
          organizationId: organization.id,
          externalRef: "test",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test",
          pkApiKey: "test",
          shortcode: "test",
        },
      });

      const day = 24 * 60 * 60 * 1000;
      const to = Date.now();
      const from = to - 60 * 60 * 1000;
      const completedAt = new Date(from + 10 * 60 * 1000);

      for (const [friendlyId, createdAt, runCompletedAt] of [
        ["run_created_1d_before", new Date(from - day), completedAt],
        ["run_created_2d_before", new Date(from - 2 * day), completedAt],
        ["run_created_10d_before", new Date(from - 10 * day), completedAt],
        ["run_created_31d_before", new Date(from - 31 * day), completedAt],
        ["run_completed_before_from", new Date(from - 10 * day), new Date(from - day)],
        ["run_not_completed", new Date(from - day), null],
      ] as const) {
        await prisma.taskRun.create({
          data: {
            friendlyId,
            taskIdentifier: "my-task",
            status: "COMPLETED_WITH_ERRORS",
            createdAt,
            completedAt: runCompletedAt,
            payload: JSON.stringify({ foo: "bar" }),
            traceId: friendlyId,
            spanId: friendlyId,
            queue: "test",
            runtimeEnvironmentId: runtimeEnvironment.id,
            projectId: project.id,
            organizationId: organization.id,
            environmentType: "DEVELOPMENT",
            engine: "V2",
          },
        });
      }

      await setTimeout(1000);

      const runsRepository = new RunsRepository({
        prisma,
        clickhouse,
      });

      const baseOptions = {
        page: { size: 10 },
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
        from,
        to,
      };

      const byCompletedAt = await runsRepository.listRuns({
        ...baseOptions,
        filterByCompletedAt: true,
      });

      expect(byCompletedAt.runs.map((r) => r.friendlyId)).toEqual([
        "run_created_1d_before",
        "run_created_2d_before",
        "run_created_10d_before",
      ]);
      expect(await runsRepository.countRuns({ ...baseOptions, filterByCompletedAt: true })).toBe(3);

      const byCreatedAt = await runsRepository.listRuns(baseOptions);

      expect(byCreatedAt.runs).toHaveLength(0);
    }
  );
});
