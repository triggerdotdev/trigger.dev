import { ClickHouse } from "@internal/clickhouse";
import { Tracer } from "@internal/tracing";
import { Logger, LogLevel } from "@trigger.dev/core/logger";
import { TaskRunStatus } from "@trigger.dev/database";
import { PrismaClient } from "~/db.server";

export type RunsRepositorySOptions = {
  clickhouse: ClickHouse;
  prisma: PrismaClient;
  logger?: Logger;
  logLevel?: LogLevel;
  tracer?: Tracer;
};

export type ListRunsOptions = {
  projectId: string;
  environmentId: string;
  //filters
  tasks?: string[];
  versions?: string[];
  statuses?: TaskRunStatus[];
  tags?: string[];
  scheduleId?: string;
  period?: string;
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
  constructor(private readonly options: RunsRepositorySOptions) {}

  async listRuns(options: ListRunsOptions) {
    const queryBuilder = this.options.clickhouse.taskRuns.queryBuilder();
    queryBuilder
      .where("environment_id = {environmentId: String}", {
        environmentId: options.environmentId,
      })
      .where("project_id = {projectId: String}", {
        projectId: options.projectId,
      });

    if (options.tasks) {
      queryBuilder.where("task_identifier IN {tasks: Array(String)}", { tasks: options.tasks });
    }

    if (options.versions) {
      queryBuilder.where("task_version IN {versions: Array(String)}", {
        versions: options.versions,
      });
    }

    if (options.statuses) {
      queryBuilder.where("status IN {statuses: Array(String)}", { statuses: options.statuses });
    }

    if (options.tags) {
      queryBuilder.where("hasAny(tags, {tags: Array(String)})", { tags: options.tags });
    }

    if (options.scheduleId) {
      queryBuilder.where("schedule_id = {scheduleId: String}", { scheduleId: options.scheduleId });
    }

    if (options.period) {
      queryBuilder.where("period = {period: String}", { period: options.period });
    }

    if (options.from) {
      queryBuilder.where("created_at >= {from: DateTime}", { from: options.from });
    }

    if (options.to) {
      queryBuilder.where("created_at <= {to: DateTime}", { to: options.to });
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

    if (options.runFriendlyIds) {
      queryBuilder.where("friendly_id IN {runFriendlyIds: Array(String)}", {
        runFriendlyIds: options.runFriendlyIds,
      });
    }

    if (options.runIds) {
      queryBuilder.where("run_id IN {runIds: Array(String)}", { runIds: options.runIds });
    }

    if (options.page.cursor) {
      if (options.page.direction === "forward") {
        queryBuilder
          .where("run_id > {runId: String}", { runId: options.page.cursor })
          .orderBy("run_id DESC")
          .limit(options.page.size + 1);
      } else {
        queryBuilder
          .where("run_id < {runId: String}", { runId: options.page.cursor })
          .orderBy("run_id ASC")
          .limit(options.page.size + 1);
      }
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
    switch (options.page.direction) {
      case "forward":
        previousCursor = options.page.cursor ? runIds.at(0) ?? null : null;
        if (hasMore) {
          nextCursor = runIds[options.page.size];
        }
        break;
      case "backward":
        runIds.reverse();
        if (hasMore) {
          previousCursor = runIds[1];
          nextCursor = runIds[options.page.size];
        } else {
          nextCursor = runIds[options.page.size - 1];
        }
        break;
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
