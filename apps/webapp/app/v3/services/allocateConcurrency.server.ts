import { setTimeout as sleep } from "node:timers/promises";
import { tryCatch } from "@trigger.dev/core";
import {
  boundedIn,
  isPrismaKnownError,
  Prisma,
  RuntimeEnvironmentType,
} from "@trigger.dev/database";
import { $transaction, type PrismaTransactionClient } from "~/db.server";
import { logger } from "~/services/logger.server";
import { getCurrentPlan, getDefaultEnvironmentLimitFromPlan } from "~/services/platform.v3.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { updateEnvConcurrencyLimits } from "../runQueue.server";
import { BaseService } from "./baseService.server";
import { concurrencySystem } from "./concurrencySystemInstance.server";

type Input = {
  userId: string;
  projectId: string;
  organizationId: string;
  environments: { id: string; amount: number }[];
};

type Result =
  | {
      success: true;
    }
  | {
      success: false;
      error: string;
    };

type CurrentPlanResult = NonNullable<Awaited<ReturnType<typeof getCurrentPlan>>>;

type UpdatedEnvironment = Prisma.RuntimeEnvironmentGetPayload<{
  include: { project: true; organization: true };
}>;

type AllocationOutcome =
  | { success: true; updatedEnvironments: UpdatedEnvironment[] }
  | { success: false; error: string };

const ALLOCATION_TRANSACTION_TIMEOUT_MS = 15_000;

const SYNC_RETRY_DELAY_MS = 500;

export class AllocateConcurrencyService extends BaseService {
  async call({ projectId, organizationId, environments }: Input): Promise<Result> {
    const [planError, currentPlan] = await tryCatch(getCurrentPlan(organizationId));

    if (planError || !currentPlan) {
      return {
        success: false,
        error: "Unknown error",
      };
    }

    /**
     * The quota check and the environment-limit writes must be atomic: two concurrent
     * allocations could otherwise both pass a stale unallocated-pool check and jointly
     * exceed the purchased quota. Serializable makes the loser of that race fail with
     * P2034, which is surfaced as a retryable error below. The quota math mirrors
     * ManageConcurrencyPresenter but runs on fresh primary reads inside the transaction:
     * row reads are bounded to the requested environments, and the org-wide allocated
     * total is one SQL aggregate, because an org can hold an unbounded number of preview
     * environments and fetching them all would blow the transaction timeout.
     */
    const [transactionError, outcome] = await tryCatch(
      $transaction(
        this._prisma,
        "AllocateConcurrencyService.call",
        async (tx): Promise<AllocationOutcome> => {
          const requested = new Map(environments.map((e) => [e.id, e.amount]));

          const requestedEnvironments = await tx.runtimeEnvironment.findMany({
            select: {
              id: true,
              type: true,
              isBranchableEnvironment: true,
              maximumConcurrencyLimit: true,
              project: {
                select: {
                  deletedAt: true,
                },
              },
            },
            where: {
              id: { in: boundedIn(Array.from(requested.keys())) },
              organizationId,
              projectId,
              archivedAt: null,
            },
          });

          const allocatable = new Map<
            string,
            { maximumConcurrencyLimit: number; planConcurrencyLimit: number }
          >();

          for (const environment of requestedEnvironments) {
            if (environment.type === "PREVIEW" && environment.isBranchableEnvironment) continue;
            if (environment.project.deletedAt) continue;

            /**
             * DEVELOPMENT environments are never allocatable: dev concurrency is not
             * purchasable, the UI posts no input for them, and extra dev limit is invisible
             * to the org-wide quota aggregate, so accepting a crafted dev id would let an
             * allocation spend past the purchased pool without ever being counted.
             */
            if (environment.type === "DEVELOPMENT") continue;

            const limit = getDefaultEnvironmentLimitFromPlan(environment.type, currentPlan);
            if (!limit) continue;

            allocatable.set(environment.id, {
              maximumConcurrencyLimit: environment.maximumConcurrencyLimit,
              planConcurrencyLimit: limit,
            });
          }

          /**
           * Every requested id must qualify BEFORE the first write. A mid-loop failure
           * would otherwise commit a partial allocation (a plain return from an
           * interactive-transaction callback commits) whose engine syncs never run,
           * leaving the run engine diverged from the database.
           */
          for (const environmentId of requested.keys()) {
            if (!allocatable.has(environmentId)) {
              return {
                success: false,
                error: `Environment not found ${environmentId}`,
              };
            }
          }

          const extraAllocatedTotal = await computeOrgExtraAllocatedConcurrency(
            tx,
            organizationId,
            currentPlan
          );

          const extraConcurrency =
            currentPlan.v3Subscription.addOns?.concurrentRuns?.purchased ?? 0;
          const extraAllocatedConcurrency = Math.min(extraConcurrency, extraAllocatedTotal);
          const extraUnallocatedConcurrency = extraConcurrency - extraAllocatedConcurrency;

          let change = 0;
          for (const [environmentId, amount] of requested) {
            const existingEnvironment = allocatable.get(environmentId)!;
            change +=
              Math.max(0, amount) -
              Math.max(
                0,
                existingEnvironment.maximumConcurrencyLimit -
                  existingEnvironment.planConcurrencyLimit
              );
          }

          const totalExtra = extraAllocatedConcurrency + change;

          if (change > extraUnallocatedConcurrency) {
            return {
              success: false,
              error: `You don't have enough unallocated concurrency available. You requested ${totalExtra} but only have ${extraUnallocatedConcurrency}.`,
            };
          }

          const updatedEnvironments: UpdatedEnvironment[] = [];

          for (const [environmentId, amount] of requested) {
            const existingEnvironment = allocatable.get(environmentId)!;
            const newConcurrency = existingEnvironment.planConcurrencyLimit + amount;

            const updatedEnvironment = await tx.runtimeEnvironment.update({
              where: {
                id: environmentId,
              },
              data: {
                maximumConcurrencyLimit: newConcurrency,
              },
              include: {
                project: true,
                organization: true,
              },
            });

            updatedEnvironments.push(updatedEnvironment);
          }

          return { success: true, updatedEnvironments };
        },
        { isolationLevel: "Serializable", timeout: ALLOCATION_TRANSACTION_TIMEOUT_MS }
      )
    );

    if (transactionError) {
      if (isPrismaKnownError(transactionError)) {
        if (transactionError.code === "P2034") {
          return {
            success: false,
            error: "The concurrency allocation changed while saving. Please try again.",
          };
        }

        if (transactionError.code === "P2028") {
          return {
            success: false,
            error: "Saving the concurrency allocation timed out. Please try again.",
          };
        }
      }

      throw transactionError;
    }

    if (!outcome) {
      return {
        success: false,
        error: "Unknown error",
      };
    }

    if (!outcome.success) {
      return outcome;
    }

    /**
     * Engine syncs run AFTER the transaction has committed, from committed rows: pushing
     * limits to the run engine from inside an open transaction could publish state that
     * later rolls back (see the recalculatePercentLimits JSDoc in concurrencySystem).
     * Each environment's sync is attempted independently, so one unavailable engine call
     * cannot strand unrelated committed updates. A failed environment gets one bounded
     * inline retry so transient engine blips self-heal without user action; a persistent
     * failure surfaces as a message pointing at the one recovery path the UI actually
     * offers (changing an allocation value re-enables Save, and a save re-syncs every
     * environment because updates run unconditionally for all posted environments).
     */
    const failedEnvironmentIds: string[] = [];

    for (const updatedEnvironment of outcome.updatedEnvironments) {
      /** maximumConcurrencyLimit changed in the control-plane; drop any cached copy. */
      controlPlaneResolver.invalidateEnvironment(updatedEnvironment.id);

      const synced = await this.syncCommittedEnvironment(updatedEnvironment.id);
      if (!synced) {
        failedEnvironmentIds.push(updatedEnvironment.id);
      }
    }

    if (failedEnvironmentIds.length > 0) {
      await sleep(SYNC_RETRY_DELAY_MS);

      const stillFailingEnvironmentIds: string[] = [];
      for (const environmentId of failedEnvironmentIds) {
        const synced = await this.syncCommittedEnvironment(environmentId);
        if (!synced) {
          stillFailingEnvironmentIds.push(environmentId);
        }
      }

      if (stillFailingEnvironmentIds.length > 0) {
        return {
          success: false,
          error:
            "Your allocation was saved, but applying the new limits has not finished. Adjust any allocation value and save again to re-apply them.",
        };
      }
    }

    return {
      success: true,
    };
  }

  /**
   * Pushes one committed environment's limits to the run engine and recalculates its
   * percent-based queue limits, reading the CURRENT committed row rather than a caller's
   * transaction snapshot: commits are serializable but post-commit syncs are not ordered,
   * so a delayed older sync could otherwise overwrite a newer committed limit in the
   * engine. Failures are logged and reported, never thrown, so callers can retry or
   * continue with other environments. Every step is idempotent.
   */
  private async syncCommittedEnvironment(environmentId: string): Promise<boolean> {
    const [readError, currentEnvironment] = await tryCatch(
      this._prisma.runtimeEnvironment.findFirst({
        where: { id: environmentId },
        include: { project: true, organization: true },
      })
    );

    if (readError || !currentEnvironment) {
      logger.error("AllocateConcurrencyService: failed to re-read environment for sync", {
        environmentId,
        error: readError,
      });
      return false;
    }

    let synced = true;

    if (!currentEnvironment.paused) {
      const [envSyncError] = await tryCatch(
        updateEnvConcurrencyLimits(currentEnvironment, undefined, this._prisma)
      );

      if (envSyncError) {
        logger.error("AllocateConcurrencyService: failed to sync environment limit", {
          environmentId: currentEnvironment.id,
          error: envSyncError,
        });
        synced = false;
      }
    }

    /**
     * Percent-based queue overrides follow the environment limit automatically. Note the
     * deliberate asymmetry with the env-level push above: `updateEnvConcurrencyLimits` is
     * gated on `!paused`, but queue limits are recalculated even for paused environments.
     * Queue-level pushes on a paused env are inert (the env-level gate stops dequeueing
     * regardless), and keeping the queue limits synced means resume needs no extra
     * reconciliation. Skipping them here would leave stale engine limits after the env
     * resumes.
     */
    const [recalcError, recalcOutcome] = await tryCatch(
      concurrencySystem.queues.recalculatePercentLimits(currentEnvironment)
    );

    if (recalcError || (recalcOutcome?.failed ?? 0) > 0) {
      logger.error("AllocateConcurrencyService: failed to recalculate queue limits", {
        environmentId: currentEnvironment.id,
        error: recalcError,
        failedQueues: recalcOutcome?.failed,
      });
      synced = false;
    }

    return synced;
  }
}

/**
 * The org-wide allocated-extra total, as ManageConcurrencyPresenter computes it, but as a
 * single SQL aggregate so it stays O(1) rows regardless of how many (unbounded) preview
 * environments the org has accumulated. The WHERE mirrors the presenter's filters exactly:
 * non-archived environments of the org, excluding branchable PREVIEW parents, environments
 * of deleted projects, DEVELOPMENT environments, and environment types without a plan limit;
 * each qualifying row contributes max(0, maximumConcurrencyLimit - planLimit).
 */
async function computeOrgExtraAllocatedConcurrency(
  tx: PrismaTransactionClient,
  organizationId: string,
  currentPlan: CurrentPlanResult
): Promise<number> {
  const typeLimits = Object.values(RuntimeEnvironmentType)
    .filter((type) => type !== "DEVELOPMENT")
    .flatMap((type) => {
      const limit = getDefaultEnvironmentLimitFromPlan(type, currentPlan);
      return limit ? [{ type, limit }] : [];
    });

  if (typeLimits.length === 0) {
    return 0;
  }

  const limitCases = Prisma.join(
    typeLimits.map((entry) => Prisma.sql`WHEN ${entry.type}::text THEN ${entry.limit}`),
    " "
  );
  const countableTypes = Prisma.join(typeLimits.map((entry) => entry.type));

  const rows = await tx.$queryRaw<{ total: bigint | number | null }[]>(Prisma.sql`
    SELECT SUM(GREATEST(0, env."maximumConcurrencyLimit" - CASE env."type"::text ${limitCases} END)) AS total
    FROM "RuntimeEnvironment" env
    JOIN "Project" p ON p."id" = env."projectId"
    WHERE env."organizationId" = ${organizationId}
      AND env."archivedAt" IS NULL
      AND p."deletedAt" IS NULL
      AND NOT (env."type"::text = 'PREVIEW' AND env."isBranchableEnvironment")
      AND env."type"::text IN (${countableTypes})
  `);

  return Number(rows[0]?.total ?? 0);
}
