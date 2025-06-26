import { type ClickHouse } from "@internal/clickhouse";
import { type ClickhouseQueryBuilder } from "@internal/clickhouse/dist/src/client/queryBuilder";
import { type Tracer } from "@internal/tracing";
import { type Logger, type LogLevel } from "@trigger.dev/core/logger";
import { type TaskRunStatus } from "@trigger.dev/database";
import parseDuration from "parse-duration";
import { timeFilters } from "~/components/runs/v3/SharedFilters";
import { type PrismaClient } from "~/db.server";

export type RunsRepositoryOptions = {
  clickhouse: ClickHouse;
  prisma: PrismaClient;
  logger?: Logger;
  logLevel?: LogLevel;
  tracer?: Tracer;
};

type RunListInputOptions = {
  organizationId: string;
  projectId: string;
  environmentId: string;
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
  runIds?: string[];
};

type FilterRunsOptions = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  //filters
  tasks?: string[];
  versions?: string[];
  statuses?: TaskRunStatus[];
  tags?: string[];
  scheduleId?: string;
  period?: number;
  from?: number;
  to?: number;
  isTest?: boolean;
  rootOnly?: boolean;
  batchId?: string;
  runFriendlyIds?: string[];
};

type Pagination = {
  page: {
    size: number;
    cursor?: string;
    direction?: "forward" | "backward";
  };
};

export type ListRunsOptions = RunListInputOptions & Pagination;

export class RunsRepository {
  constructor(private readonly options: RunsRepositoryOptions) {}

  async listRunIds(options: ListRunsOptions) {
    const queryBuilder = this.options.clickhouse.taskRuns.queryBuilder();
    applyRunFiltersToQueryBuilder(
      queryBuilder,
      await this.#convertRunListInputOptionsToFilterRunsOptions(options)
    );

    if (options.page.cursor) {
      if (options.page.direction === "forward") {
        queryBuilder
          .where("run_id < {runId: String}", { runId: options.page.cursor })
          .orderBy("created_at DESC, run_id DESC")
          .limit(options.page.size + 1);
      } else {
        queryBuilder
          .where("run_id > {runId: String}", { runId: options.page.cursor })
          .orderBy("created_at ASC, run_id ASC")
          .limit(options.page.size + 1);
      }
    } else {
      // Initial page - no cursor provided
      queryBuilder.orderBy("created_at DESC, run_id DESC").limit(options.page.size + 1);
    }

    const [queryError, result] = await queryBuilder.execute();

    if (queryError) {
      throw queryError;
    }

    const runIds = result.map((row) => row.run_id);
    return runIds;
  }

  async listRuns(options: ListRunsOptions) {
    const runIds = await this.listRunIds(options);

    // If there are more runs than the page size, we need to fetch the next page
    const hasMore = runIds.length > options.page.size;

    let nextCursor: string | null = null;
    let previousCursor: string | null = null;

    //get cursors for next and previous pages
    const direction = options.page.direction ?? "forward";
    switch (direction) {
      case "forward": {
        previousCursor = options.page.cursor ? runIds.at(0) ?? null : null;
        if (hasMore) {
          // The next cursor should be the last run ID from this page
          nextCursor = runIds[options.page.size - 1];
        }
        break;
      }
      case "backward": {
        const reversedRunIds = [...runIds].reverse();
        if (hasMore) {
          previousCursor = reversedRunIds.at(1) ?? null;
          nextCursor = reversedRunIds.at(options.page.size) ?? null;
        } else {
          nextCursor = reversedRunIds.at(options.page.size - 1) ?? null;
        }

        break;
      }
    }

    const runIdsToReturn =
      options.page.direction === "backward" && hasMore
        ? runIds.slice(1, options.page.size + 1)
        : runIds.slice(0, options.page.size);

    const runs = await this.options.prisma.taskRun.findMany({
      where: {
        id: {
          in: runIdsToReturn,
        },
      },
      orderBy: {
        id: "desc",
      },
      select: {
        id: true,
        friendlyId: true,
        taskIdentifier: true,
        taskVersion: true,
        runtimeEnvironmentId: true,
        status: true,
        createdAt: true,
        startedAt: true,
        lockedAt: true,
        delayUntil: true,
        updatedAt: true,
        completedAt: true,
        isTest: true,
        spanId: true,
        idempotencyKey: true,
        ttl: true,
        expiredAt: true,
        costInCents: true,
        baseCostInCents: true,
        usageDurationMs: true,
        runTags: true,
        depth: true,
        rootTaskRunId: true,
        batchId: true,
        metadata: true,
        metadataType: true,
      },
    });

    return {
      runs,
      pagination: {
        nextCursor,
        previousCursor,
      },
    };
  }

  async countRuns(options: RunListInputOptions) {
    const queryBuilder = this.options.clickhouse.taskRuns.countQueryBuilder();
    applyRunFiltersToQueryBuilder(
      queryBuilder,
      await this.#convertRunListInputOptionsToFilterRunsOptions(options)
    );

    const [queryError, result] = await queryBuilder.execute();

    if (queryError) {
      throw queryError;
    }

    if (result.length === 0) {
      throw new Error("No count rows returned");
    }

    return result[0].count;
  }

  async #convertRunListInputOptionsToFilterRunsOptions(
    options: RunListInputOptions
  ): Promise<FilterRunsOptions> {
    const convertedOptions: FilterRunsOptions = {
      ...options,
      period: undefined,
    };

    // Convert time period to ms
    const time = timeFilters({
      period: options.period,
      from: options.from,
      to: options.to,
    });
    convertedOptions.period = time.period ? parseDuration(time.period) ?? undefined : undefined;

    // batch friendlyId to id
    if (options.batchId && options.batchId.startsWith("batch_")) {
      const batch = await this.options.prisma.batchTaskRun.findFirst({
        select: {
          id: true,
        },
        where: {
          friendlyId: options.batchId,
          runtimeEnvironmentId: options.environmentId,
        },
      });

      if (batch) {
        convertedOptions.batchId = batch.id;
      }
    }

    // scheduleId can be a friendlyId
    if (options.scheduleId && options.scheduleId.startsWith("sched_")) {
      const schedule = await this.options.prisma.taskSchedule.findFirst({
        select: {
          id: true,
        },
        where: {
          friendlyId: options.scheduleId,
          projectId: options.projectId,
        },
      });

      if (schedule) {
        convertedOptions.scheduleId = schedule?.id;
      }
    }

    // Show all runs if we are filtering by batchId or runId
    if (options.batchId || options.runIds?.length || options.scheduleId || options.tasks?.length) {
      convertedOptions.rootOnly = false;
    }

    return convertedOptions;
  }
}

function applyRunFiltersToQueryBuilder<T>(
  queryBuilder: ClickhouseQueryBuilder<T>,
  options: FilterRunsOptions
) {
  queryBuilder
    .where("organization_id = {organizationId: String}", {
      organizationId: options.organizationId,
    })
    .where("project_id = {projectId: String}", {
      projectId: options.projectId,
    })
    .where("environment_id = {environmentId: String}", {
      environmentId: options.environmentId,
    });

  if (options.tasks && options.tasks.length > 0) {
    queryBuilder.where("task_identifier IN {tasks: Array(String)}", { tasks: options.tasks });
  }

  if (options.versions && options.versions.length > 0) {
    queryBuilder.where("task_version IN {versions: Array(String)}", {
      versions: options.versions,
    });
  }

  if (options.statuses && options.statuses.length > 0) {
    queryBuilder.where("status IN {statuses: Array(String)}", { statuses: options.statuses });
  }

  if (options.tags && options.tags.length > 0) {
    queryBuilder.where("hasAny(tags, {tags: Array(String)})", { tags: options.tags });
  }

  if (options.scheduleId) {
    queryBuilder.where("schedule_id = {scheduleId: String}", { scheduleId: options.scheduleId });
  }

  // Period is a number of milliseconds duration
  if (options.period) {
    queryBuilder.where("created_at >= fromUnixTimestamp64Milli({period: Int64})", {
      period: new Date(Date.now() - options.period).getTime(),
    });
  }

  if (options.from) {
    queryBuilder.where("created_at >= fromUnixTimestamp64Milli({from: Int64})", {
      from: options.from,
    });
  }

  if (options.to) {
    queryBuilder.where("created_at <= fromUnixTimestamp64Milli({to: Int64})", { to: options.to });
  }

  if (typeof options.isTest === "boolean") {
    queryBuilder.where("is_test = {isTest: Boolean}", { isTest: options.isTest });
  }

  if (options.rootOnly) {
    queryBuilder.where("root_run_id = ''");
  }

  if (options.batchId) {
    queryBuilder.where("batch_id = {batchId: String}", { batchId: options.batchId });
  }

  // TODO new bulk action filtering

  if (options.runFriendlyIds && options.runFriendlyIds.length > 0) {
    queryBuilder.where("friendly_id IN {runFriendlyIds: Array(String)}", {
      runFriendlyIds: options.runFriendlyIds,
    });
  }
}
