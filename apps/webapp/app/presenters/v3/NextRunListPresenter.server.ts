import { type ClickHouse } from "@internal/clickhouse";
import type { MachinePresetName } from "@trigger.dev/core/v3";
import { RunAnnotations } from "@trigger.dev/core/v3/schemas";
import {
  type PrismaClient,
  type PrismaClientOrTransaction,
  type TaskRunStatus,
} from "@trigger.dev/database";
import { type Direction } from "~/components/ListPagination";
import { timeFilters } from "~/components/runs/v3/SharedFilters";
import { findDisplayableEnvironment } from "~/models/runtimeEnvironment.server";
import { getTaskIdentifiers } from "~/models/task.server";
import { RunsRepository } from "~/services/runsRepository/runsRepository.server";
import { env } from "~/env.server";
import {
  createCache,
  createLRUMemoryStore,
  DefaultStatefulContext,
  Namespace,
} from "@internal/cache";
import { RedisCacheStore } from "~/services/unkey/redisCacheStore.server";
import { singleton } from "~/utils/singleton";
import { regionForDisplay } from "~/runEngine/concerns/workerQueueSplit.server";
import { machinePresetFromRun } from "~/v3/machinePresets.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { isCancellableRunStatus, isFinalRunStatus, isPendingRunStatus } from "~/v3/taskStatus";

// Positive-only cache: only envs known to have runs are stored (empty envs are re-checked),
// so "has runs" is monotonic and the TTL can be very long. Tiered memory + Redis.
const runsExistCache = singleton("runsExistCache", () => {
  const ctx = new DefaultStatefulContext();
  const memory = createLRUMemoryStore(5000, "runs-has-runs-cache");
  const redis = new RedisCacheStore({
    name: "runs-has-runs",
    connection: {
      keyPrefix: "tr:cache:runs-has-runs",
      port: env.CACHE_REDIS_PORT,
      host: env.CACHE_REDIS_HOST,
      username: env.CACHE_REDIS_USERNAME,
      password: env.CACHE_REDIS_PASSWORD,
      tlsDisabled: env.CACHE_REDIS_TLS_DISABLED === "true",
      clusterMode: env.CACHE_REDIS_CLUSTER_MODE_ENABLED === "1",
    },
  });

  return createCache({
    hasRuns: new Namespace<boolean>(ctx, {
      stores: [memory, redis],
      fresh: env.RUN_LIST_HAS_RUNS_CACHE_FRESH_MS,
      stale: env.RUN_LIST_HAS_RUNS_CACHE_STALE_MS,
    }),
  });
});

export type RunListOptions = {
  userId?: string;
  projectId: string;
  //filters
  tasks?: string[];
  versions?: string[];
  statuses?: TaskRunStatus[];
  tags?: string[];
  scheduleId?: string;
  period?: string;
  bulkId?: string;
  from?: number;
  to?: number;
  isTest?: boolean;
  rootOnly?: boolean;
  batchId?: string;
  runId?: string[];
  queues?: string[];
  regions?: string[];
  machines?: MachinePresetName[];
  errorId?: string;
  sources?: string[];
  //pagination
  direction?: Direction;
  cursor?: string;
  pageSize?: number;
  // Run the empty-state "has any run ever" probe. Only the runs list consumes it.
  includeHasAnyRuns?: boolean;
};

const DEFAULT_PAGE_SIZE = 25;

export type NextRunList = Awaited<ReturnType<NextRunListPresenter["call"]>>;
export type NextRunListItem = NextRunList["runs"][0];
export type NextRunListAppliedFilters = NextRunList["filters"];

export class NextRunListPresenter {
  constructor(
    private readonly replica: PrismaClientOrTransaction,
    private readonly clickhouse: ClickHouse,
    private readonly readThroughDeps?: {
      // The new run-ops client + the legacy run-ops read replica (never the legacy writer).
      // Omitted => single-DB / self-host: both default to `replica` (passthrough).
      newClient?: PrismaClientOrTransaction;
      legacyReplica?: PrismaClientOrTransaction;
      // Resolved boot constant from isSplitEnabled(). When false/absent:
      // list hydrate runs passthrough and the empty-state probe is one plain findFirst.
      splitEnabled?: boolean;
    }
  ) {}

  // Empty-state existence probe, served from ClickHouse (same connection as the runs
  // list) so it no longer scans TaskRun in Postgres. SWR-cached to spare ClickHouse;
  // RUN_LIST_HAS_RUNS_LOOKBACK_DAYS bounds the prove-absence partition scan.
  async #anyRunExistsInEnv(
    runsRepository: RunsRepository,
    organizationId: string,
    projectId: string,
    environmentId: string
  ): Promise<boolean> {
    const lookbackDays = env.RUN_LIST_HAS_RUNS_LOOKBACK_DAYS;
    const createdAtLowerBoundMs =
      lookbackDays > 0 ? Date.now() - lookbackDays * 24 * 60 * 60 * 1000 : undefined;

    const result = await runsExistCache.hasRuns.swr(environmentId, async () => {
      const exists = await runsRepository.runExistsInEnvironment({
        organizationId,
        projectId,
        environmentId,
        createdAtLowerBoundMs,
      });
      // undefined (not false) so swr does NOT cache the empty result — re-check until a run exists.
      return exists ? true : undefined;
    });

    return result.val ?? false;
  }

  public async call(
    organizationId: string,
    environmentId: string,
    {
      userId,
      projectId,
      tasks,
      versions,
      statuses,
      tags,
      scheduleId,
      period,
      bulkId,
      isTest,
      rootOnly,
      batchId,
      runId,
      queues,
      regions,
      machines,
      errorId,
      sources,
      from,
      to,
      direction = "forward",
      cursor,
      pageSize = DEFAULT_PAGE_SIZE,
      includeHasAnyRuns = false,
    }: RunListOptions
  ) {
    //get the time values from the raw values (including a default period)
    const time = timeFilters({
      period,
      from,
      to,
    });

    const hasStatusFilters = statuses && statuses.length > 0;

    const hasFilters =
      (sources !== undefined && sources.length > 0) ||
      (tasks !== undefined && tasks.length > 0) ||
      (versions !== undefined && versions.length > 0) ||
      hasStatusFilters ||
      (bulkId !== undefined && bulkId !== "") ||
      (scheduleId !== undefined && scheduleId !== "") ||
      (tags !== undefined && tags.length > 0) ||
      batchId !== undefined ||
      (runId !== undefined && runId.length > 0) ||
      (queues !== undefined && queues.length > 0) ||
      (regions !== undefined && regions.length > 0) ||
      (machines !== undefined && machines.length > 0) ||
      (errorId !== undefined && errorId !== "") ||
      typeof isTest === "boolean" ||
      rootOnly === true ||
      !time.isDefault;

    const possibleTasksAsync = getTaskIdentifiers(environmentId);

    const bulkActionsAsync = this.replica.bulkActionGroup.findMany({
      select: {
        friendlyId: true,
        type: true,
        createdAt: true,
        name: true,
      },
      where: {
        projectId: projectId,
        environmentId,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 20,
    });

    const [possibleTasks, bulkActions, displayableEnvironment] = await Promise.all([
      possibleTasksAsync,
      bulkActionsAsync,
      findDisplayableEnvironment(environmentId, userId),
    ]);

    // If the bulk action isn't in the most recent ones, add it separately
    if (bulkId && !bulkActions.some((bulkAction) => bulkAction.friendlyId === bulkId)) {
      const selectedBulkAction = await this.replica.bulkActionGroup.findFirst({
        select: {
          friendlyId: true,
          type: true,
          createdAt: true,
          name: true,
        },
        where: {
          friendlyId: bulkId,
          projectId,
          environmentId,
        },
      });

      if (selectedBulkAction) {
        bulkActions.push(selectedBulkAction);
      }
    }

    if (!displayableEnvironment) {
      throw new ServiceValidationError("No environment found");
    }

    const runsRepository = new RunsRepository({
      clickhouse: this.clickhouse,
      prisma: this.replica as PrismaClient,
      readThrough: this.readThroughDeps
        ? {
            newClient: this.readThroughDeps.newClient ?? this.replica,
            legacyReplica: this.readThroughDeps.legacyReplica ?? this.replica,
            splitEnabled: this.readThroughDeps.splitEnabled ?? false,
          }
        : undefined,
    });

    function clampToNow(date: Date): Date {
      const now = new Date();
      return date > now ? now : date;
    }

    const { runs, pagination } = await runsRepository.listRuns({
      organizationId,
      environmentId,
      projectId,
      tasks,
      versions,
      statuses,
      tags,
      scheduleId,
      period,
      from: time.from ? time.from.getTime() : undefined,
      to: time.to ? clampToNow(time.to).getTime() : undefined,
      isTest,
      rootOnly,
      batchId,
      runId,
      bulkId,
      queues,
      regions,
      machines,
      errorId,
      taskKinds: sources,
      page: {
        size: pageSize,
        cursor,
        direction,
      },
    });

    let hasAnyRuns = runs.length > 0;

    if (!hasAnyRuns && includeHasAnyRuns) {
      hasAnyRuns = await this.#anyRunExistsInEnv(
        runsRepository,
        organizationId,
        projectId,
        environmentId
      );
    }

    return {
      runs: runs.map((run) => {
        const hasFinished = isFinalRunStatus(run.status);

        const startedAt = run.startedAt ?? run.lockedAt;

        return {
          id: run.id,
          number: 1,
          friendlyId: run.friendlyId,
          createdAt: run.createdAt.toISOString(),
          updatedAt: run.updatedAt.toISOString(),
          startedAt: startedAt ? startedAt.toISOString() : undefined,
          delayUntil: run.delayUntil ? run.delayUntil.toISOString() : undefined,
          hasFinished,
          finishedAt: hasFinished
            ? (run.completedAt?.toISOString() ?? run.updatedAt.toISOString())
            : undefined,
          isTest: run.isTest,
          status: run.status,
          version: run.taskVersion,
          taskIdentifier: run.taskIdentifier,
          spanId: run.spanId,
          isReplayable: true,
          isCancellable: isCancellableRunStatus(run.status),
          isPending: isPendingRunStatus(run.status),
          environment: displayableEnvironment,
          idempotencyKey: run.idempotencyKey ? run.idempotencyKey : undefined,
          ttl: run.ttl ? run.ttl : undefined,
          expiredAt: run.expiredAt ? run.expiredAt.toISOString() : undefined,
          costInCents: run.costInCents,
          baseCostInCents: run.baseCostInCents,
          usageDurationMs: Number(run.usageDurationMs),
          tags: run.runTags ? run.runTags.sort((a, b) => a.localeCompare(b)) : [],
          depth: run.depth,
          rootTaskRunId: run.rootTaskRunId,
          metadata: run.metadata,
          metadataType: run.metadataType,
          machinePreset: run.machinePreset ? machinePresetFromRun(run)?.name : undefined,
          queue: {
            name: run.queue.replace("task/", ""),
            type: run.queue.startsWith("task/") ? "task" : "custom",
          },
          region: regionForDisplay(run.region, run.workerQueue),
          taskKind: RunAnnotations.safeParse(run.annotations).data?.taskKind ?? "STANDARD",
        };
      }),
      pagination: {
        next: pagination.nextCursor ?? undefined,
        previous: pagination.previousCursor ?? undefined,
      },
      possibleTasks,
      bulkActions: bulkActions.map((bulkAction) => ({
        id: bulkAction.friendlyId,
        type: bulkAction.type,
        createdAt: bulkAction.createdAt,
        name: bulkAction.name || bulkAction.friendlyId,
      })),
      filters: {
        tasks: tasks || [],
        versions: versions || [],
        statuses: statuses || [],
        from: time.from,
        to: time.to,
      },
      hasFilters,
      hasAnyRuns,
    };
  }
}
