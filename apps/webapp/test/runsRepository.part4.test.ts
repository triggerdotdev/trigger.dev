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

describe("RunsRepository (part 4/4)", () => {
  replicationContainerTest(
    "should filter runs by date range (from/to)",
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

      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      // Create runs with different creation dates
      await prisma.taskRun.create({
        data: {
          friendlyId: "run_yesterday",
          taskIdentifier: "my-task",
          createdAt: yesterday,
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
          friendlyId: "run_today",
          taskIdentifier: "my-task",
          createdAt: now,
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
          friendlyId: "run_tomorrow",
          taskIdentifier: "my-task",
          createdAt: tomorrow,
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

      // Test filtering by date range (from yesterday to today)
      const { runs } = await runsRepository.listRuns({
        page: { size: 10 },
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
        from: yesterday.getTime(),
        to: now.getTime(),
      });

      expect(runs).toHaveLength(2);
      expect(runs.map((r) => r.friendlyId).sort()).toEqual(["run_today", "run_yesterday"]);
    }
  );

  replicationContainerTest(
    "should handle multiple filters combined",
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

      // Create runs with different combinations of properties
      await prisma.taskRun.create({
        data: {
          friendlyId: "run_match",
          taskIdentifier: "task-1",
          taskVersion: "1.0.0",
          status: "COMPLETED_SUCCESSFULLY",
          isTest: false,
          runTags: ["urgent"],
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
          friendlyId: "run_no_match_task",
          taskIdentifier: "task-2", // Different task
          taskVersion: "1.0.0",
          status: "COMPLETED_SUCCESSFULLY",
          isTest: false,
          runTags: ["urgent"],
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
          friendlyId: "run_no_match_status",
          taskIdentifier: "task-1",
          taskVersion: "1.0.0",
          status: "PENDING", // Different status
          isTest: false,
          runTags: ["urgent"],
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

      // Test combining multiple filters
      const { runs } = await runsRepository.listRuns({
        page: { size: 10 },
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
        tasks: ["task-1"],
        versions: ["1.0.0"],
        statuses: ["COMPLETED_SUCCESSFULLY"],
        isTest: false,
        tags: ["urgent"],
      });

      expect(runs).toHaveLength(1);
      expect(runs[0].friendlyId).toBe("run_match");
    }
  );

  replicationContainerTest(
    "should handle pagination correctly",
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

      // Create multiple runs for pagination testing
      const runs = [];
      for (let i = 1; i <= 5; i++) {
        const run = await prisma.taskRun.create({
          data: {
            friendlyId: `run_${i}`,
            taskIdentifier: "my-task",
            payload: JSON.stringify({ foo: "bar" }),
            traceId: `123${i}`,
            spanId: `123${i}`,
            queue: "test",
            runtimeEnvironmentId: runtimeEnvironment.id,
            projectId: project.id,
            organizationId: organization.id,
            environmentType: "DEVELOPMENT",
            engine: "V2",
          },
        });
        runs.push(run);
      }

      await setTimeout(1000);

      const runsRepository = new RunsRepository({
        prisma,
        clickhouse,
      });

      // Test first page
      const firstPage = await runsRepository.listRuns({
        page: { size: 2 },
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
      });

      expect(firstPage.runs).toHaveLength(2);
      expect(firstPage.pagination.nextCursor).toBeTruthy();
      expect(firstPage.pagination.previousCursor).toBe(null);

      // Test next page using cursor
      const secondPage = await runsRepository.listRuns({
        page: {
          size: 2,
          cursor: firstPage.pagination.nextCursor!,
          direction: "forward",
        },
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
      });

      expect(secondPage.runs).toHaveLength(2);
      expect(secondPage.pagination.nextCursor).toBeTruthy();
      expect(secondPage.pagination.previousCursor).toBeTruthy();
    }
  );

  replicationContainerTest(
    "should count new runs with listRunIds",
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

      const taskRun = await prisma.taskRun.create({
        data: {
          friendlyId: "run_has_new",
          taskIdentifier: "my-task",
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

      await setTimeout(1000);

      const runsRepository = new RunsRepository({
        prisma,
        clickhouse,
      });

      const baseOptions = {
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
      };

      const createdAtMs = taskRun.createdAt.getTime();

      const newRunIdsBefore = await runsRepository.listRunIds({
        ...baseOptions,
        from: createdAtMs - 1,
        page: { size: 100 },
      });
      expect(newRunIdsBefore.length).toBeGreaterThanOrEqual(1);

      const newRunIdsAfter = await runsRepository.listRunIds({
        ...baseOptions,
        from: createdAtMs + 60_000,
        page: { size: 100 },
      });
      expect(newRunIdsAfter).toHaveLength(0);

      const fromBeforeRun = createdAtMs - 1;

      const matchingTaskIds = await runsRepository.listRunIds({
        ...baseOptions,
        from: fromBeforeRun,
        tasks: ["my-task"],
        page: { size: 100 },
      });
      expect(matchingTaskIds.length).toBeGreaterThanOrEqual(1);

      const otherTaskIds = await runsRepository.listRunIds({
        ...baseOptions,
        from: fromBeforeRun,
        tasks: ["other-task"],
        page: { size: 100 },
      });
      expect(otherTaskIds).toHaveLength(0);
    }
  );
});
