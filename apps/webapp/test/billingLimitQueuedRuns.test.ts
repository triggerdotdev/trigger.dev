import { describe, expect, vi } from "vitest";
import { setTimeout } from "node:timers/promises";
import { replicationContainerTest } from "@internal/testcontainers";
import { RunsRepository } from "~/services/runsRepository/runsRepository.server";
import {
  countBillableQueuedRunsForOrganization,
  countQueuedRunsForBillableEnvironment,
  getBillableEnvironmentsForBillingLimit,
} from "~/v3/services/billingLimit/billingLimitQueuedRuns.server";
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

  replicationContainerTest(
    "counts queued runs org-wide with a single query, spanning billable environment types only",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      const organization = await prisma.organization.create({
        data: { title: "billing-limit-org-count", slug: "billing-limit-org-count" },
      });

      const project = await prisma.project.create({
        data: {
          name: "billing-limit-org-count",
          slug: "billing-limit-org-count",
          organizationId: organization.id,
          externalRef: "billing-limit-org-count",
        },
      });

      const productionEnv = await prisma.runtimeEnvironment.create({
        data: {
          slug: "prod",
          type: "PRODUCTION",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "prod-org-count",
          pkApiKey: "prod-org-count",
          shortcode: "prod-org-count",
        },
      });

      const developmentEnv = await prisma.runtimeEnvironment.create({
        data: {
          slug: "dev",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "dev-org-count",
          pkApiKey: "dev-org-count",
          shortcode: "dev-org-count",
        },
      });

      const previewEnv = await prisma.runtimeEnvironment.create({
        data: {
          slug: "preview",
          type: "PREVIEW",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "preview-org-count",
          pkApiKey: "preview-org-count",
          shortcode: "preview-org-count",
          branchName: "feature-branch",
          archivedAt: new Date(),
        },
      });

      const runRows = [
        {
          friendlyId: "run_org_prod_pending",
          env: productionEnv,
          type: "PRODUCTION",
          status: "PENDING",
        },
        {
          friendlyId: "run_org_prod_delayed",
          env: productionEnv,
          type: "PRODUCTION",
          status: "DELAYED",
        },
        {
          friendlyId: "run_org_prod_done",
          env: productionEnv,
          type: "PRODUCTION",
          status: "COMPLETED_SUCCESSFULLY",
        },
        {
          friendlyId: "run_org_dev_pending",
          env: developmentEnv,
          type: "DEVELOPMENT",
          status: "PENDING",
        },
        {
          friendlyId: "run_org_preview_pending",
          env: previewEnv,
          type: "PREVIEW",
          status: "PENDING",
        },
      ] as const;

      for (const row of runRows) {
        await prisma.taskRun.create({
          data: {
            friendlyId: row.friendlyId,
            taskIdentifier: "queued-task",
            status: row.status,
            payload: JSON.stringify({}),
            traceId: "trace",
            spanId: "span",
            queue: "main",
            runtimeEnvironmentId: row.env.id,
            projectId: project.id,
            organizationId: organization.id,
            environmentType: row.type,
            engine: "V2",
          },
        });
      }

      await setTimeout(1000);

      const count = await countBillableQueuedRunsForOrganization(organization.id, clickhouse);

      expect(count).toBe(3);
    }
  );

  replicationContainerTest(
    "keeps archived environments in the billable environment list so enforcement can cancel their runs",
    async ({ prisma }) => {
      const organization = await prisma.organization.create({
        data: { title: "billing-limit-archived", slug: "billing-limit-archived" },
      });

      const project = await prisma.project.create({
        data: {
          name: "billing-limit-archived",
          slug: "billing-limit-archived",
          organizationId: organization.id,
          externalRef: "billing-limit-archived",
        },
      });

      const activeEnv = await prisma.runtimeEnvironment.create({
        data: {
          slug: "preview-active",
          type: "PREVIEW",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "preview-active-test",
          pkApiKey: "preview-active-test",
          shortcode: "preview-active-test",
          branchName: "live-branch",
        },
      });

      const archivedEnv = await prisma.runtimeEnvironment.create({
        data: {
          slug: "preview-archived",
          type: "PREVIEW",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "preview-archived-test",
          pkApiKey: "preview-archived-test",
          shortcode: "preview-archived-test",
          branchName: "old-branch",
          archivedAt: new Date(),
        },
      });

      const developmentEnv = await prisma.runtimeEnvironment.create({
        data: {
          slug: "dev",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "dev-archived-test",
          pkApiKey: "dev-archived-test",
          shortcode: "dev-archived-test",
        },
      });

      const environments = await getBillableEnvironmentsForBillingLimit(organization.id, prisma);
      const environmentIds = environments.map((environment) => environment.id).sort();

      expect(environmentIds).toEqual([activeEnv.id, archivedEnv.id].sort());
      expect(environmentIds).not.toContain(developmentEnv.id);
    }
  );
});
