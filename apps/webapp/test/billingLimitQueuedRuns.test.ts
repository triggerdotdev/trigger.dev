import { describe, expect, vi } from "vitest";
import { setTimeout } from "node:timers/promises";
import { replicationContainerTest } from "@internal/testcontainers";
import { RunsRepository } from "~/services/runsRepository/runsRepository.server";
import { countQueuedRunsForBillableEnvironment } from "~/v3/services/billingLimit/billingLimitQueuedRuns.server";
import { setupClickhouseReplication } from "./utils/replicationUtils";

vi.setConfig({ testTimeout: 60_000 });

describe("billingLimitQueuedRuns", () => {
  replicationContainerTest(
    "counts queued runs via RunsRepository.countRuns (same source as bulk cancel)",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      const organization = await prisma.organization.create({
        data: { title: "billing-limit-queued", slug: "billing-limit-queued" },
      });

      const project = await prisma.project.create({
        data: {
          name: "billing-limit-queued",
          slug: "billing-limit-queued",
          organizationId: organization.id,
          externalRef: "billing-limit-queued",
        },
      });

      const productionEnv = await prisma.runtimeEnvironment.create({
        data: {
          slug: "prod",
          type: "PRODUCTION",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "prod",
          pkApiKey: "prod",
          shortcode: "prod",
        },
      });

      const developmentEnv = await prisma.runtimeEnvironment.create({
        data: {
          slug: "dev",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "dev",
          pkApiKey: "dev",
          shortcode: "dev",
        },
      });

      await prisma.taskRun.create({
        data: {
          friendlyId: "run_queued_prod",
          taskIdentifier: "queued-task",
          status: "PENDING",
          payload: JSON.stringify({}),
          traceId: "trace",
          spanId: "span",
          queue: "main",
          runtimeEnvironmentId: productionEnv.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "PRODUCTION",
          engine: "V2",
        },
      });

      await prisma.taskRun.create({
        data: {
          friendlyId: "run_queued_dev",
          taskIdentifier: "queued-task",
          status: "PENDING",
          payload: JSON.stringify({}),
          traceId: "trace",
          spanId: "span",
          queue: "main",
          runtimeEnvironmentId: developmentEnv.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      await setTimeout(1000);

      const runsRepository = new RunsRepository({ prisma, clickhouse });

      const productionCount = await countQueuedRunsForBillableEnvironment(
        runsRepository,
        organization.id,
        { id: productionEnv.id, projectId: project.id }
      );

      const developmentCount = await countQueuedRunsForBillableEnvironment(
        runsRepository,
        organization.id,
        { id: developmentEnv.id, projectId: project.id }
      );

      expect(productionCount).toBe(1);
      expect(developmentCount).toBe(1);
    }
  );
});
