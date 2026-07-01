import { BulkActionId } from "@trigger.dev/core/v3/isomorphic";
import { type Prisma, BulkActionNotificationType, BulkActionStatus, BulkActionType, type PrismaClient, type TaskRunStatus } from "@trigger.dev/database";
import { QUEUED_STATUSES, RUNNING_STATUSES } from "~/components/runs/v3/TaskRunStatus";
import { prisma } from "~/db.server";
import type { RunsRepository } from "~/services/runsRepository/runsRepository.server";
import {
  countInProgressRunsForBillableEnvironment,
  countQueuedRunsForBillableEnvironment,
  createBillingLimitRunsRepository,
  getBillableEnvironmentsForBillingLimit,
} from "./billingLimitQueuedRuns.server";
import { BILLING_LIMIT_RESOLVE_BULK_CANCEL_BUDGET_MS } from "./billingLimitConstants";

export const BILLING_LIMIT_RESOLVE_CANCEL_SOURCE = "billing_limit_resolve_new_only";
export const BILLING_LIMIT_IN_PROGRESS_CANCEL_SOURCE = "billing_limit_in_progress";

export class BillingLimitBulkCancelIncompleteError extends Error {
  constructor(readonly bulkActionId: string) {
    super(`Billing limit bulk cancel did not complete within time budget: ${bulkActionId}`);
    this.name = "BillingLimitBulkCancelIncompleteError";
  }
}

type BulkCancelSource =
  | typeof BILLING_LIMIT_RESOLVE_CANCEL_SOURCE
  | typeof BILLING_LIMIT_IN_PROGRESS_CANCEL_SOURCE;

export type BillingLimitBulkCancelDeps = {
  prismaClient?: PrismaClient;
  createRunsRepository?: (organizationId: string) => Promise<RunsRepository>;
  enqueueProcessBulkAction?: (bulkActionId: string) => Promise<unknown>;
  processBulkActionToCompletion?: (
    bulkActionId: string,
    options?: { deadline?: number }
  ) => Promise<{ completed: boolean }>;
};

function resolveBulkCancelDeps(deps?: BillingLimitBulkCancelDeps) {
  return {
    prismaClient: deps?.prismaClient ?? prisma,
    createRunsRepository: deps?.createRunsRepository ?? createBillingLimitRunsRepository,
    enqueueProcessBulkAction:
      deps?.enqueueProcessBulkAction ??
      (async (bulkActionId: string) => {
        // Imported dynamically for the same reason as BulkActionService below:
        // commonWorker.server transitively loads marqs -> the
        // TaskRunConcurrencyTracker singleton, which throws when REDIS_HOST/
        // REDIS_PORT are unset (e.g. the webapp unit-test CI job).
        const { commonWorker } = await import("~/v3/commonWorker.server");
        await commonWorker.enqueue({
          id: `processBulkAction-${bulkActionId}`,
          job: "processBulkAction",
          payload: { bulkActionId },
        });
      }),
    processBulkActionToCompletion:
      deps?.processBulkActionToCompletion ??
      (async (bulkActionId: string, options?: { deadline?: number }) => {
        // Imported dynamically so this module doesn't eagerly load BulkActionV2 ->
        // CancelTaskRunService -> marqs -> the TaskRunConcurrencyTracker singleton,
        // which throws when REDIS_HOST/REDIS_PORT are unset (e.g. the webapp
        // unit-test CI job).
        const { BulkActionService } = await import("~/v3/services/bulk/BulkActionV2.server");
        const service = new BulkActionService();
        return service.processToCompletion(bulkActionId, { deadline: options?.deadline });
      }),
  };
}

export class BillingLimitBulkCancelService {
  static async cancelQueuedRuns(
    organizationId: string,
    options?: {
      dedupeKey?: string;
      waitForCompletion?: boolean;
      bulkCancelDeadline?: number;
    },
    deps?: BillingLimitBulkCancelDeps
  ): Promise<{ bulkActionIds: string[] }> {
    return this.cancelRunsForBillableEnvironments(
      organizationId,
      {
        source: BILLING_LIMIT_RESOLVE_CANCEL_SOURCE,
        statuses: [...QUEUED_STATUSES],
        name: "Billing limit resolve — cancel queued runs",
        countRuns: countQueuedRunsForBillableEnvironment,
        dedupeKey: options?.dedupeKey,
        waitForCompletion: options?.waitForCompletion,
        bulkCancelDeadline: options?.bulkCancelDeadline,
      },
      deps
    );
  }

  static async cancelInProgressRuns(
    organizationId: string,
    options: { hitAt: string },
    deps?: BillingLimitBulkCancelDeps
  ): Promise<{ bulkActionIds: string[] }> {
    return this.cancelRunsForBillableEnvironments(
      organizationId,
      {
        source: BILLING_LIMIT_IN_PROGRESS_CANCEL_SOURCE,
        statuses: [...RUNNING_STATUSES],
        name: "Billing limit hit — cancel in-progress runs",
        countRuns: countInProgressRunsForBillableEnvironment,
        dedupeKey: options.hitAt,
      },
      deps
    );
  }

  private static async cancelRunsForBillableEnvironments(
    organizationId: string,
    options: {
      source: BulkCancelSource;
      statuses: TaskRunStatus[];
      name: string;
      countRuns: typeof countQueuedRunsForBillableEnvironment;
      dedupeKey?: string;
      waitForCompletion?: boolean;
      bulkCancelDeadline?: number;
    },
    deps?: BillingLimitBulkCancelDeps
  ): Promise<{ bulkActionIds: string[] }> {
    const {
      prismaClient,
      createRunsRepository,
      enqueueProcessBulkAction,
      processBulkActionToCompletion,
    } = resolveBulkCancelDeps(deps);

    const environments = await getBillableEnvironmentsForBillingLimit(organizationId, prismaClient);

    if (environments.length === 0) {
      return { bulkActionIds: [] };
    }

    const runsRepository = await createRunsRepository(organizationId);
    const bulkActionIds: string[] = [];
    const bulkActionInternalIds: string[] = [];

    for (const environment of environments) {
      if (options.dedupeKey) {
        const existing = await prismaClient.bulkActionGroup.findFirst({
          where: {
            environmentId: environment.id,
            type: BulkActionType.CANCEL,
            dedupeKey: options.dedupeKey,
            status: { not: BulkActionStatus.ABORTED },
          },
          select: { id: true, friendlyId: true, status: true },
          orderBy: { createdAt: "desc" },
        });

        if (existing) {
          bulkActionIds.push(existing.friendlyId);

          if (existing.status === BulkActionStatus.COMPLETED) {
            continue;
          }

          if (options.waitForCompletion) {
            bulkActionInternalIds.push(existing.id);
          } else {
            await enqueueProcessBulkAction(existing.id);
          }
          continue;
        }
      }

      const count = await options.countRuns(runsRepository, organizationId, environment);

      if (count === 0) {
        continue;
      }

      const { id, friendlyId } = BulkActionId.generate();

      await prismaClient.bulkActionGroup.create({
        data: {
          id,
          friendlyId,
          projectId: environment.projectId,
          environmentId: environment.id,
          name: options.name,
          type: BulkActionType.CANCEL,
          dedupeKey: options.dedupeKey,
          params: {
            statuses: options.statuses,
            finalizeRun: true,
            source: options.source,
            ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
          } as Prisma.InputJsonValue,
          queryName: "bulk_action_v1",
          totalCount: count,
          completionNotification: BulkActionNotificationType.NONE,
        },
      });

      if (options.waitForCompletion) {
        bulkActionInternalIds.push(id);
      } else {
        await enqueueProcessBulkAction(id);
      }

      bulkActionIds.push(friendlyId);
    }

    if (options.waitForCompletion) {
      const deadline =
        options.bulkCancelDeadline ?? Date.now() + BILLING_LIMIT_RESOLVE_BULK_CANCEL_BUDGET_MS;

      for (const bulkActionId of bulkActionInternalIds) {
        const result = await processBulkActionToCompletion(bulkActionId, { deadline });
        if (!result.completed) {
          throw new BillingLimitBulkCancelIncompleteError(bulkActionId);
        }
      }
    }

    return { bulkActionIds };
  }
}
