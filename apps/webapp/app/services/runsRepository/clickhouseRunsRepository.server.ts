import { type ClickhouseQueryBuilder } from "@internal/clickhouse";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import {
  type FilterRunsOptions,
  type IRunsRepository,
  type ListRunsOptions,
  type RunListInputOptions,
  type RunsRepositoryOptions,
  type TagListOptions,
  convertRunListInputOptionsToFilterRunsOptions,
} from "./runsRepository.server";
import parseDuration from "parse-duration";

export class ClickHouseRunsRepository implements IRunsRepository {
  constructor(private readonly options: RunsRepositoryOptions) {}

  get name() {
    return "clickhouse";
  }

  async listRunIds(options: ListRunsOptions) {
    const queryBuilder = this.options.clickhouse.taskRuns.queryBuilder();
    applyRunFiltersToQueryBuilder(
      queryBuilder,
      await convertRunListInputOptionsToFilterRunsOptions(options, this.options.prisma)
    );

    if (options.page.cursor) {
      if (options.page.direction === "forward" || !options.page.direction) {
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

  async listFriendlyRunIds(options: ListRunsOptions) {
    // First get internal IDs from ClickHouse
    const internalIds = await this.listRunIds(options);

    if (internalIds.length === 0) {
      return [];
    }

    // Then get friendly IDs from Prisma
    const runs = await this.options.prisma.taskRun.findMany({
      where: {
        id: {
          in: internalIds,
        },
      },
      select: {
        friendlyId: true,
      },
    });

    return runs.map((run) => run.friendlyId);
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

    let runs = await this.options.prisma.taskRun.findMany({
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
        machinePreset: true,
        queue: true,
      },
    });

    // ClickHouse is slightly delayed, so we're going to do in-memory status filtering too
    if (options.statuses && options.statuses.length > 0) {
      runs = runs.filter((run) => options.statuses!.includes(run.status));
    }

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
      await convertRunListInputOptionsToFilterRunsOptions(options, this.options.prisma)
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

  async listTags(options: TagListOptions) {
    const queryBuilder = this.options.clickhouse.taskRuns
      .tagQueryBuilder()
      .where("organization_id = {organizationId: String}", {
        organizationId: options.organizationId,
      })
      .where("project_id = {projectId: String}", {
        projectId: options.projectId,
      })
      .where("environment_id = {environmentId: String}", {
        environmentId: options.environmentId,
      });

    const periodMs = options.period ? parseDuration(options.period) ?? undefined : undefined;
    if (periodMs) {
      queryBuilder.where("created_at >= fromUnixTimestamp64Milli({period: Int64})", {
        period: new Date(Date.now() - periodMs).getTime(),
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

    // Filter by query (case-insensitive contains search)
    if (options.query && options.query.trim().length > 0) {
      queryBuilder.where("positionCaseInsensitiveUTF8(tag, {query: String}) > 0", {
        query: options.query,
      });
    }

    // Add ordering and pagination
    queryBuilder.orderBy("tag ASC").limit(options.limit);

    const [queryError, result] = await queryBuilder.execute();

    if (queryError) {
      throw queryError;
    }

    return {
      tags: result.map((row) => row.tag),
    };
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

  if (options.bulkId) {
    queryBuilder.where("hasAny(bulk_action_group_ids, {bulkActionGroupIds: Array(String)})", {
      bulkActionGroupIds: [options.bulkId],
    });
  }

  if (options.runId && options.runId.length > 0) {
    // it's important that in the query it's "runIds", otherwise it clashes with the cursor which is called "runId"
    queryBuilder.where("friendly_id IN {runIds: Array(String)}", {
      runIds: options.runId.map((runId) => RunId.toFriendlyId(runId)),
    });
  }

  if (options.queues && options.queues.length > 0) {
    queryBuilder.where("queue IN {queues: Array(String)}", { queues: options.queues });
  }

  if (options.machines && options.machines.length > 0) {
    queryBuilder.where("machine_preset IN {machines: Array(String)}", {
      machines: options.machines,
    });
  }
}
