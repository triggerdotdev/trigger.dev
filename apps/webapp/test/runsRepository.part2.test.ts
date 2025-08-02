import { describe, expect, vi } from "vitest";

// Mock the db prisma client
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

import { containerTest } from "@internal/testcontainers";
import { setTimeout } from "node:timers/promises";
import { RunsRepository } from "~/services/runsRepository/runsRepository.server";
import { setupClickhouseReplication } from "./utils/replicationUtils";

vi.setConfig({ testTimeout: 60_000 });

describe("RunsRepository (part 2/2)", () => {
  containerTest(
    "should filter runs by rootOnly flag",
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

      // Create a root run
      const rootRun = await prisma.taskRun.create({
        data: {
          friendlyId: "run_root",
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

      // Create a child run
      await prisma.taskRun.create({
        data: {
          friendlyId: "run_child",
          taskIdentifier: "my-task",
          rootTaskRunId: rootRun.id,
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

      // Test filtering by rootOnly=true
      const { runs } = await runsRepository.listRuns({
        page: { size: 10 },
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
        rootOnly: true,
      });

      expect(runs).toHaveLength(1);
      expect(runs[0].friendlyId).toBe("run_root");
    }
  );

  containerTest(
    "should filter runs by batchId",
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

      const batchRun1 = await prisma.batchTaskRun.create({
        data: {
          friendlyId: "batch_1",
          runtimeEnvironmentId: runtimeEnvironment.id,
          status: "PENDING",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      // Create runs with different batch IDs
      await prisma.taskRun.create({
        data: {
          friendlyId: "run_batch_1",
          taskIdentifier: "my-task",
          batchId: batchRun1.id,
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

      const batchRun2 = await prisma.batchTaskRun.create({
        data: {
          friendlyId: "batch_2",
          runtimeEnvironmentId: runtimeEnvironment.id,
          status: "PENDING",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      await prisma.taskRun.create({
        data: {
          friendlyId: "run_batch_2",
          taskIdentifier: "my-task",
          batchId: batchRun2.id,
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
          friendlyId: "run_no_batch",
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

      // Test filtering by batch ID
      const { runs } = await runsRepository.listRuns({
        page: { size: 10 },
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
        batchId: batchRun1.id,
      });

      expect(runs).toHaveLength(1);
      expect(runs[0].friendlyId).toBe("run_batch_1");
    }
  );

  containerTest(
    "should filter runs by runFriendlyIds",
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

      // Create runs with different friendly IDs
      await prisma.taskRun.create({
        data: {
          friendlyId: "run_abc",
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

      await prisma.taskRun.create({
        data: {
          friendlyId: "run_def",
          taskIdentifier: "my-task",
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
          friendlyId: "run_xyz",
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

      // Test filtering by friendly IDs
      const { runs } = await runsRepository.listRuns({
        page: { size: 10 },
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
        runId: ["run_abc", "run_xyz"],
      });

      expect(runs).toHaveLength(2);
      expect(runs.map((r) => r.friendlyId).sort()).toEqual(["run_abc", "run_xyz"]);
    }
  );

  containerTest(
    "should filter runs by runIds",
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

      // Create runs to get their IDs
      const run1 = await prisma.taskRun.create({
        data: {
          friendlyId: "run_1",
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

      const run2 = await prisma.taskRun.create({
        data: {
          friendlyId: "run_2",
          taskIdentifier: "my-task",
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

      const run3 = await prisma.taskRun.create({
        data: {
          friendlyId: "run_3",
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

      await setTimeout(1_000);

      const runsRepository = new RunsRepository({
        prisma,
        clickhouse,
      });

      // Test filtering by run IDs
      const { runs } = await runsRepository.listRuns({
        page: { size: 10 },
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
        runId: [run1.friendlyId, run3.friendlyId],
      });

      expect(runs).toHaveLength(2);
      expect(runs.map((r) => r.id).sort()).toEqual([run1.id, run3.id].sort());
    }
  );

  containerTest(
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

  containerTest(
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

  containerTest(
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
});