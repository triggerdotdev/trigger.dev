import { type ClickHouse } from "@internal/clickhouse";
import { type Tracer } from "@internal/tracing";
import { type Logger, type LogLevel } from "@trigger.dev/core/logger";
import { type TaskRunStatus } from "@trigger.dev/database";
import { type PrismaClient } from "~/db.server";

export type RunsRepositoryOptions = {
  clickhouse: ClickHouse;
  prisma: PrismaClient;
  logger?: Logger;
  logLevel?: LogLevel;
  tracer?: Tracer;
};

export type ListRunsOptions = {
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
  runIds?: string[];
  //pagination
  page: {
    size: number;
    cursor?: string;
    direction?: "forward" | "backward";
  };
};

export class RunsRepository {
  constructor(private readonly options: RunsRepositoryOptions) {}

  async listRuns(options: ListRunsOptions) {
    const queryBuilder = this.options.clickhouse.taskRuns.queryBuilder();
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

    if (options.runFriendlyIds && options.runFriendlyIds.length > 0) {
      queryBuilder.where("friendly_id IN {runFriendlyIds: Array(String)}", {
        runFriendlyIds: options.runFriendlyIds,
      });
    }

    if (options.runIds && options.runIds.length > 0) {
      queryBuilder.where("run_id IN {runIds: Array(String)}", { runIds: options.runIds });
    }

    if (options.page.cursor) {
      if (options.page.direction === "forward") {
        queryBuilder
          .where("run_id < {runId: String}", { runId: options.page.cursor })
          .orderBy("created_at DESC, run_id DESC")
          .limit(options.page.size + 1);
      } else {
        queryBuilder
          .where("run_id > {runId: String}", { runId: options.page.cursor })
          .orderBy("created_at DESC, run_id DESC")
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

    // If there are more runs than the page size, we need to fetch the next page
    const hasMore = runIds.length > options.page.size;

    let nextCursor: string | null = null;
    let previousCursor: string | null = null;

    //get cursors for next and previous pages
    if (options.page.cursor) {
      switch (options.page.direction) {
        case "forward":
          previousCursor = runIds.at(0) ?? null;
          if (hasMore) {
            // The next cursor should be the last run ID from this page
            nextCursor = runIds[options.page.size - 1];
          }
          break;
        case "backward":
          // No need to reverse since we're using DESC ordering consistently
          if (hasMore) {
            previousCursor = runIds[options.page.size - 1];
          }
          nextCursor = runIds.at(0) ?? null;
          break;
        default:
          // This shouldn't happen if cursor is provided, but handle it
          if (hasMore) {
            nextCursor = runIds[options.page.size - 1];
          }
          break;
      }
    } else {
      // Initial page - no cursor
      if (hasMore) {
        // The next cursor should be the last run ID from this page
        nextCursor = runIds[options.page.size - 1];
      }
    }

    const runIdsToReturn = hasMore ? runIds.slice(0, -1) : runIds;

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
}
