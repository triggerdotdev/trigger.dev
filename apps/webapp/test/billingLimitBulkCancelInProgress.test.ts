import { describe, expect, vi } from "vitest";
import { setTimeout } from "node:timers/promises";
import { postgresTest, replicationContainerTest } from "@internal/testcontainers";
import { BulkActionStatus, BulkActionType } from "@trigger.dev/database";
import {
  BILLING_LIMIT_IN_PROGRESS_CANCEL_SOURCE,
  BILLING_LIMIT_RESOLVE_CANCEL_SOURCE,
  BillingLimitBulkCancelIncompleteError,
  BillingLimitBulkCancelService,
} from "~/v3/services/billingLimit/BillingLimitBulkCancelService.server";
import { countInProgressRunsForBillableEnvironment } from "~/v3/services/billingLimit/billingLimitQueuedRuns.server";
import { RunsRepository } from "~/services/runsRepository/runsRepository.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";
import { setupClickhouseReplication } from "./utils/replicationUtils";

vi.setConfig({ testTimeout: 60_000 });

describe("BillingLimitBulkCancelService.cancelQueuedRuns", () => {
  postgresTest(
    "processes bulk cancel inline when waitForCompletion is true",
    async ({ prisma }) => {
      const { organization, project } = await createTestOrgProjectWithMember(prisma);
      const productionEnv = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "PRODUCTION",
        slug: uniqueId("prod"),
      });

      const dedupeKey = "billing-limit-resolve:org:2026-06-16T12:00:00.000Z";
      const enqueuedBulkActionIds: string[] = [];
      const processedBulkActionIds: string[] = [];

      const result = await BillingLimitBulkCancelService.cancelQueuedRuns(
        organization.id,
        { dedupeKey, waitForCompletion: true },
        {
          prismaClient: prisma,
          createRunsRepository: async () =>
            ({
              countRuns: async () => 2,
            }) as never,
          enqueueProcessBulkAction: async (bulkActionId) => {
            enqueuedBulkActionIds.push(bulkActionId);
          },
          processBulkActionToCompletion: async (bulkActionId) => {
            processedBulkActionIds.push(bulkActionId);
            return { completed: true };
          },
        }
      );

      expect(result.bulkActionIds).toHaveLength(1);
      expect(enqueuedBulkActionIds).toEqual([]);
      expect(processedBulkActionIds).toHaveLength(1);

      const group = await prisma.bulkActionGroup.findFirst({
        where: {
          environmentId: productionEnv.id,
          type: BulkActionType.CANCEL,
        },
      });

      expect(group?.name).toBe("Billing limit resolve — cancel queued runs");
      expect(group?.dedupeKey).toBe(dedupeKey);
      expect(group?.params).toMatchObject({
        source: BILLING_LIMIT_RESOLVE_CANCEL_SOURCE,
        dedupeKey,
        finalizeRun: true,
      });
      expect(processedBulkActionIds).toEqual([group?.id]);
    }
  );

  postgresTest(
    "reuses existing bulk cancel and processes inline when waitForCompletion is true",
    async ({ prisma }) => {
      const { organization, project } = await createTestOrgProjectWithMember(prisma);
      const productionEnv = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "PRODUCTION",
        slug: uniqueId("prod"),
      });

      const dedupeKey = "billing-limit-resolve:org:2026-06-16T12:00:00.000Z";

      await prisma.bulkActionGroup.create({
        data: {
          id: "bulk_existing_resolve",
          friendlyId: "bulk_existing_resolve",
          projectId: project.id,
          environmentId: productionEnv.id,
          name: "Existing resolve cancel",
          type: BulkActionType.CANCEL,
          dedupeKey,
          params: {
            statuses: ["PENDING"],
            finalizeRun: true,
            source: BILLING_LIMIT_RESOLVE_CANCEL_SOURCE,
            dedupeKey,
          },
          queryName: "bulk_action_v1",
          totalCount: 1,
        },
      });

      const enqueuedBulkActionIds: string[] = [];
      const processedBulkActionIds: string[] = [];

      const result = await BillingLimitBulkCancelService.cancelQueuedRuns(
        organization.id,
        { dedupeKey, waitForCompletion: true },
        {
          prismaClient: prisma,
          // Stubbed so the dedupe path doesn't build the default ClickHouse-backed
          // repository, which queries the global $replica and hangs in the
          // unit-test CI job (no reachable database/ClickHouse there).
          createRunsRepository: async () =>
            ({
              countRuns: async () => 0,
            }) as never,
          enqueueProcessBulkAction: async (bulkActionId) => {
            enqueuedBulkActionIds.push(bulkActionId);
          },
          processBulkActionToCompletion: async (bulkActionId) => {
            processedBulkActionIds.push(bulkActionId);
            return { completed: true };
          },
        }
      );

      expect(result.bulkActionIds).toEqual(["bulk_existing_resolve"]);
      expect(enqueuedBulkActionIds).toEqual([]);
      expect(processedBulkActionIds).toEqual(["bulk_existing_resolve"]);
    }
  );

  postgresTest(
    "skips enqueue and processing for completed deduped bulk actions",
    async ({ prisma }) => {
      const { organization, project } = await createTestOrgProjectWithMember(prisma);
      const productionEnv = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "PRODUCTION",
        slug: uniqueId("prod"),
      });

      const dedupeKey = "billing-limit-resolve:org:2026-06-16T12:00:00.000Z";

      await prisma.bulkActionGroup.create({
        data: {
          id: "bulk_completed_resolve",
          friendlyId: "bulk_completed_resolve",
          projectId: project.id,
          environmentId: productionEnv.id,
          name: "Completed resolve cancel",
          type: BulkActionType.CANCEL,
          status: BulkActionStatus.COMPLETED,
          dedupeKey,
          params: {
            statuses: ["PENDING"],
            finalizeRun: true,
            source: BILLING_LIMIT_RESOLVE_CANCEL_SOURCE,
            dedupeKey,
          },
          queryName: "bulk_action_v1",
          totalCount: 1,
        },
      });

      const enqueuedBulkActionIds: string[] = [];
      const processedBulkActionIds: string[] = [];

      const result = await BillingLimitBulkCancelService.cancelQueuedRuns(
        organization.id,
        { dedupeKey, waitForCompletion: true },
        {
          prismaClient: prisma,
          createRunsRepository: async () =>
            ({
              countRuns: async () => 0,
            }) as never,
          enqueueProcessBulkAction: async (bulkActionId) => {
            enqueuedBulkActionIds.push(bulkActionId);
          },
          processBulkActionToCompletion: async (bulkActionId) => {
            processedBulkActionIds.push(bulkActionId);
            return { completed: true };
          },
        }
      );

      expect(result.bulkActionIds).toEqual(["bulk_completed_resolve"]);
      expect(enqueuedBulkActionIds).toEqual([]);
      expect(processedBulkActionIds).toEqual([]);
    }
  );

  postgresTest(
    "creates a fresh bulk action when the deduped action was aborted",
    async ({ prisma }) => {
      const { organization, project } = await createTestOrgProjectWithMember(prisma);
      const productionEnv = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "PRODUCTION",
        slug: uniqueId("prod"),
      });

      const dedupeKey = "billing-limit-resolve:org:2026-06-16T12:00:00.000Z";

      await prisma.bulkActionGroup.create({
        data: {
          id: "bulk_aborted_resolve",
          friendlyId: "bulk_aborted_resolve",
          projectId: project.id,
          environmentId: productionEnv.id,
          name: "Aborted resolve cancel",
          type: BulkActionType.CANCEL,
          status: BulkActionStatus.ABORTED,
          dedupeKey,
          params: {
            statuses: ["PENDING"],
            finalizeRun: true,
            source: BILLING_LIMIT_RESOLVE_CANCEL_SOURCE,
            dedupeKey,
          },
          queryName: "bulk_action_v1",
          totalCount: 1,
        },
      });

      const enqueuedBulkActionIds: string[] = [];

      const result = await BillingLimitBulkCancelService.cancelQueuedRuns(
        organization.id,
        { dedupeKey },
        {
          prismaClient: prisma,
          createRunsRepository: async () =>
            ({
              countRuns: async () => 2,
            }) as never,
          enqueueProcessBulkAction: async (bulkActionId) => {
            enqueuedBulkActionIds.push(bulkActionId);
          },
        }
      );

      expect(result.bulkActionIds).toHaveLength(1);
      expect(result.bulkActionIds[0]).not.toBe("bulk_aborted_resolve");
      expect(enqueuedBulkActionIds).toHaveLength(1);

      const groups = await prisma.bulkActionGroup.findMany({
        where: { environmentId: productionEnv.id, type: BulkActionType.CANCEL },
        orderBy: { createdAt: "asc" },
      });

      expect(groups).toHaveLength(2);
      expect(groups[1]?.status).toBe(BulkActionStatus.PENDING);
      expect(groups[1]?.dedupeKey).toBe(dedupeKey);
    }
  );

  postgresTest("throws when inline bulk cancel exceeds the time budget", async ({ prisma }) => {
    const { organization, project } = await createTestOrgProjectWithMember(prisma);
    await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
      slug: uniqueId("prod"),
    });

    const dedupeKey = "billing-limit-resolve:org:2026-06-16T12:00:00.000Z";

    await expect(
      BillingLimitBulkCancelService.cancelQueuedRuns(
        organization.id,
        { dedupeKey, waitForCompletion: true, bulkCancelDeadline: Date.now() },
        {
          prismaClient: prisma,
          createRunsRepository: async () =>
            ({
              countRuns: async () => 2,
            }) as never,
          processBulkActionToCompletion: async () => ({ completed: false }),
        }
      )
    ).rejects.toBeInstanceOf(BillingLimitBulkCancelIncompleteError);
  });
});

describe("BillingLimitBulkCancelService.cancelInProgressRuns", () => {
  postgresTest("dedupes bulk cancel by hitAt per environment", async ({ prisma }) => {
    const { organization, project } = await createTestOrgProjectWithMember(prisma);
    const productionEnv = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
      slug: uniqueId("prod"),
    });

    const hitAt = "2026-06-16T12:00:00.000Z";

    await prisma.bulkActionGroup.create({
      data: {
        id: "bulk_existing",
        friendlyId: "bulk_existing",
        projectId: project.id,
        environmentId: productionEnv.id,
        name: "Existing in-progress cancel",
        type: BulkActionType.CANCEL,
        dedupeKey: hitAt,
        params: {
          statuses: ["EXECUTING"],
          finalizeRun: true,
          source: BILLING_LIMIT_IN_PROGRESS_CANCEL_SOURCE,
          dedupeKey: hitAt,
        },
        queryName: "bulk_action_v1",
        totalCount: 1,
      },
    });

    const enqueuedBulkActionIds: string[] = [];

    const result = await BillingLimitBulkCancelService.cancelInProgressRuns(
      organization.id,
      { hitAt },
      {
        prismaClient: prisma,
        // Stubbed so the dedupe path doesn't build the default ClickHouse-backed
        // repository, which queries the global $replica and hangs in the
        // unit-test CI job (no reachable database/ClickHouse there).
        createRunsRepository: async () =>
          ({
            countRuns: async () => 0,
          }) as never,
        enqueueProcessBulkAction: async (bulkActionId) => {
          enqueuedBulkActionIds.push(bulkActionId);
        },
      }
    );

    expect(result.bulkActionIds).toEqual(["bulk_existing"]);
    expect(enqueuedBulkActionIds).toEqual(["bulk_existing"]);

    const groups = await prisma.bulkActionGroup.findMany({
      where: { environmentId: productionEnv.id, type: BulkActionType.CANCEL },
    });

    expect(groups).toHaveLength(1);
  });

  replicationContainerTest(
    "creates bulk cancel for in-progress runs in billable environments",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      const organization = await prisma.organization.create({
        data: { title: "billing-limit-in-progress-runs", slug: "billing-limit-in-progress-runs" },
      });

      const project = await prisma.project.create({
        data: {
          name: "billing-limit-in-progress-runs",
          slug: "billing-limit-in-progress-runs",
          organizationId: organization.id,
          externalRef: "billing-limit-in-progress-runs",
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

      await prisma.taskRun.create({
        data: {
          friendlyId: "run_executing_prod",
          taskIdentifier: "running-task",
          status: "EXECUTING",
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

      await setTimeout(1000);

      const runsRepository = new RunsRepository({ prisma, clickhouse });

      const count = await countInProgressRunsForBillableEnvironment(
        runsRepository,
        organization.id,
        { id: productionEnv.id, projectId: project.id }
      );

      expect(count).toBe(1);

      const hitAt = "2026-06-16T12:00:00.000Z";
      const enqueuedBulkActionIds: string[] = [];

      const result = await BillingLimitBulkCancelService.cancelInProgressRuns(
        organization.id,
        { hitAt },
        {
          prismaClient: prisma,
          createRunsRepository: async () => runsRepository,
          enqueueProcessBulkAction: async (bulkActionId) => {
            enqueuedBulkActionIds.push(bulkActionId);
          },
        }
      );

      expect(result.bulkActionIds).toHaveLength(1);
      expect(enqueuedBulkActionIds).toHaveLength(1);

      const group = await prisma.bulkActionGroup.findFirst({
        where: {
          environmentId: productionEnv.id,
          type: BulkActionType.CANCEL,
        },
      });

      expect(group?.name).toBe("Billing limit hit — cancel in-progress runs");
      expect(group?.dedupeKey).toBe(hitAt);
      expect(group?.params).toMatchObject({
        source: BILLING_LIMIT_IN_PROGRESS_CANCEL_SOURCE,
        dedupeKey: hitAt,
        finalizeRun: true,
      });
    }
  );
});
