import { describe, expect, vi } from "vitest";

// Mock the db prisma client
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

import { replicationContainerTest } from "@internal/testcontainers";
import { setTimeout } from "node:timers/promises";
import { PostgresRunStore } from "@internal/run-store";
import {
  convertRunListInputOptionsToFilterRunsOptions,
  RunsRepository,
} from "~/services/runsRepository/runsRepository.server";
import { setupClickhouseReplication } from "./utils/replicationUtils";

vi.setConfig({ testTimeout: 60_000 });

describe("RunsRepository (part 2/4)", () => {
  replicationContainerTest(
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

  replicationContainerTest(
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

  replicationContainerTest(
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

      // A run ID filter looks the runs up through the run store.
      const runsRepository = new RunsRepository({
        prisma,
        clickhouse,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
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

  replicationContainerTest(
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

      const _run2 = await prisma.taskRun.create({
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
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
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

  // Catches: a run ID older than the 7-day default being missed, or the run ID query reading
  // outside the creation times of the runs it was asked for.
  replicationContainerTest(
    "should find old runs by ID without a time filter",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      const organization = await prisma.organization.create({
        data: { title: "test", slug: "test" },
      });
      const project = await prisma.project.create({
        data: { name: "test", slug: "test", organizationId: organization.id, externalRef: "test" },
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
      const createRun = (friendlyId: string, daysAgo: number) =>
        prisma.taskRun.create({
          data: {
            friendlyId,
            taskIdentifier: "my-task",
            payload: JSON.stringify({ foo: "bar" }),
            traceId: friendlyId,
            spanId: friendlyId,
            queue: "test",
            runtimeEnvironmentId: runtimeEnvironment.id,
            projectId: project.id,
            organizationId: organization.id,
            environmentType: "DEVELOPMENT",
            engine: "V2",
            createdAt: new Date(Date.now() - daysAgo * day),
          },
        });

      const oldest = await createRun("run_oldest", 400);
      const old = await createRun("run_old", 30);
      await createRun("run_between", 100);

      await setTimeout(1_000);

      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const runsRepository = new RunsRepository({ prisma, clickhouse, runStore: store });
      const scope = {
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
      };

      const { runs } = await runsRepository.listRuns({
        ...scope,
        page: { size: 10 },
        runId: [oldest.friendlyId, old.friendlyId],
      });
      expect(runs.map((r) => r.id).sort()).toEqual([oldest.id, old.id].sort());

      expect(await runsRepository.countRuns({ ...scope, runId: [old.friendlyId] })).toBe(1);

      // The window is the runs' own creation times: nothing outside it is read.
      const filter = await convertRunListInputOptionsToFilterRunsOptions(
        { ...scope, runId: [oldest.friendlyId, old.friendlyId, "run_missing"] },
        prisma,
        store
      );
      expect(filter.period).toBeUndefined();
      expect(filter.from).toBeLessThanOrEqual(oldest.createdAt.getTime());
      expect(filter.from).toBeGreaterThan(oldest.createdAt.getTime() - day);
      expect(filter.to).toBeGreaterThanOrEqual(old.createdAt.getTime());
      expect(filter.to).toBeLessThan(old.createdAt.getTime() + day);

      // IDs that aren't runs here fall back to the default period.
      const unknown = await convertRunListInputOptionsToFilterRunsOptions(
        { ...scope, runId: ["run_missing"] },
        prisma,
        store
      );
      expect(unknown.period).toBe(7 * day);
      expect(unknown.from).toBeUndefined();
    }
  );
});
