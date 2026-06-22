import { type ClickhouseQueryBuilder } from "@internal/clickhouse";
import { ErrorId, RunId } from "@trigger.dev/core/v3/isomorphic";
import {
  type FilterRunsOptions,
  type IRunsRepository,
  type ListRunsOptions,
  type RunIdsPage,
  type RunListInputOptions,
  type RunsRepositoryOptions,
  type TagListOptions,
  convertRunListInputOptionsToFilterRunsOptions,
} from "./runsRepository.server";
import parseDuration from "parse-duration";
import { decodeRunsCursor, encodeRunsCursor } from "./runsCursor.server";
import { runStore } from "~/v3/runStore.server";

type RunCursorRow = { runId: string; createdAt: number };

export class ClickHouseRunsRepository implements IRunsRepository {
  constructor(private readonly options: RunsRepositoryOptions) {}

  get name() {
    return "clickhouse";
  }

  /**
   * Runs the keyset-paginated query and returns `{ runId, createdAt }` rows
   * (one extra beyond `page.size` to signal "has more"). The ordering is always
   * the composite `(created_at, run_id)`; the cursor predicate must match it.
   *
   * Composite cursors carry both components, so we cut on the
   * `(created_at, run_id)` tuple — sound regardless of how run_id order relates
   * to created_at order. Legacy bare-run_id cursors fall back to the old
   * `run_id`-only predicate (knowingly unsound) for backwards compatibility
   * with in-flight cursors.
   */
  private async listRunRows(options: ListRunsOptions): Promise<RunCursorRow[]> {
    const queryBuilder = this.options.clickhouse.taskRuns.queryBuilder();
    applyRunFiltersToQueryBuilder(
      queryBuilder,
      await convertRunListInputOptionsToFilterRunsOptions(options, this.options.prisma)
    );

    const forward = options.page.direction === "forward" || !options.page.direction;

    if (options.page.cursor) {
      const decoded = decodeRunsCursor(options.page.cursor);

      if (forward) {
        if (decoded.kind === "composite") {
          queryBuilder.where(
            "(created_at, run_id) < (fromUnixTimestamp64Milli({cursorCreatedAt: Int64}), {runId: String})",
            { cursorCreatedAt: decoded.createdAt, runId: decoded.runId }
          );
        } else {
          queryBuilder.where("run_id < {runId: String}", { runId: decoded.runId });
        }
        queryBuilder.orderBy("created_at DESC, run_id DESC");
      } else {
        if (decoded.kind === "composite") {
          queryBuilder.where(
            "(created_at, run_id) > (fromUnixTimestamp64Milli({cursorCreatedAt: Int64}), {runId: String})",
            { cursorCreatedAt: decoded.createdAt, runId: decoded.runId }
          );
        } else {
          queryBuilder.where("run_id > {runId: String}", { runId: decoded.runId });
        }
        queryBuilder.orderBy("created_at ASC, run_id ASC");
      }

      queryBuilder.limit(options.page.size + 1);
    } else {
      // Initial page - no cursor provided
      queryBuilder.orderBy("created_at DESC, run_id DESC").limit(options.page.size + 1);
    }

    const [queryError, result] = await queryBuilder.execute();

    if (queryError) {
      throw queryError;
    }

    return result.map((row) => ({ runId: row.run_id, createdAt: row.created_at_ms }));
  }

  /**
   * A keyset-paginated page of run ids ordered by `(created_at, run_id)`, plus
   * the cursors to page forward/backward. Cursors are composite tokens that
   * match the ordering, so pagination can't duplicate or skip runs even when
   * run_id order diverges from created_at order. This is the single source of
   * cursor construction — `listRuns` and bulk actions both build on it.
   */
  async listRunIds(options: ListRunsOptions): Promise<RunIdsPage> {
    const rows = await this.listRunRows(options);

    // listRunRows fetches one extra row beyond page.size to detect "has more".
    const hasMore = rows.length > options.page.size;

    const cursorFor = (row: RunCursorRow | undefined): string | null =>
      row ? encodeRunsCursor(row.createdAt, row.runId) : null;

    let nextCursor: string | null = null;
    let previousCursor: string | null = null;

    const direction = options.page.direction ?? "forward";
    switch (direction) {
      case "forward": {
        previousCursor = options.page.cursor ? cursorFor(rows.at(0)) : null;
        if (hasMore) {
          // The next cursor is the last run on this page.
          nextCursor = cursorFor(rows[options.page.size - 1]);
        }
        break;
      }
      case "backward": {
        const reversedRows = [...rows].reverse();
        if (hasMore) {
          previousCursor = cursorFor(reversedRows.at(1));
          nextCursor = cursorFor(reversedRows.at(options.page.size));
        } else {
          // No newer rows, so there's no previous (newer) page. The next
          // (older) cursor is the oldest row on this page = rows[0] (rows are
          // ASC here). Index by the actual row count, not page.size — on a
          // partial page (fewer than page.size rows) page.size-1 overshoots
          // and would null the cursor, stranding forward navigation.
          nextCursor = cursorFor(rows.at(0));
        }
        break;
      }
    }

    // The page is always the first `page.size` rows of the result. listRunRows
    // fetches one extra row only to detect `hasMore`; that extra row is the
    // farthest from the cursor in BOTH directions (forward orders DESC, backward
    // orders ASC), so it's always the trailing element to drop — never the
    // leading one. (Slicing `[1, size+1]` for backward dropped the row closest
    // to the cursor and kept the has-more sentinel, straddling two pages.)
    const runIds = rows.slice(0, options.page.size).map((row) => row.runId);

    return { runIds, pagination: { nextCursor, previousCursor } };
  }

  async listFriendlyRunIds(options: ListRunsOptions) {
    // First get internal IDs from ClickHouse
    const { runIds } = await this.listRunIds(options);

    if (runIds.length === 0) {
      return [];
    }

    // Then get friendly IDs from Prisma
    const runs = await runStore.findRuns(
      {
        where: {
          id: {
            in: runIds,
          },
        },
        select: {
          friendlyId: true,
        },
      },
      this.options.prisma
    );

    return runs.map((run) => run.friendlyId);
  }

  async listRuns(options: ListRunsOptions) {
    const { runIds, pagination } = await this.listRunIds(options);

    let runs = await runStore.findRuns(
      {
        where: {
          id: {
            in: runIds,
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
          workerQueue: true,
          region: true,
          annotations: true,
        },
      },
      this.options.prisma
    );

    // ClickHouse is slightly delayed, so we're going to do in-memory status filtering too
    if (options.statuses && options.statuses.length > 0) {
      runs = runs.filter((run) => options.statuses!.includes(run.status));
    }

    return {
      runs,
      pagination,
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
    // Both hasAny and hasAll are served by the tags bloom_filter skip index.
    const tagsFn = options.tagsMatch === "all" ? "hasAll" : "hasAny";
    queryBuilder.where(`${tagsFn}(tags, {tags: Array(String)})`, { tags: options.tags });
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

  if (options.regions && options.regions.length > 0) {
    queryBuilder.where("if(region != '', region, worker_queue) IN {regions: Array(String)}", {
      regions: options.regions,
    });
  }

  if (options.machines && options.machines.length > 0) {
    queryBuilder.where("machine_preset IN {machines: Array(String)}", {
      machines: options.machines,
    });
  }

  if (options.errorId) {
    queryBuilder.where("error_fingerprint = {errorFingerprint: String}", {
      errorFingerprint: ErrorId.toId(options.errorId),
    });
  }

  if (options.taskKinds && options.taskKinds.length > 0) {
    const includesStandard = options.taskKinds.includes("STANDARD");
    // Include empty string when filtering for STANDARD (default value for pre-existing runs)
    const effectiveKinds = includesStandard
      ? [...options.taskKinds, ""]
      : options.taskKinds;

    if (effectiveKinds.length === 1) {
      queryBuilder.where("task_kind = {taskKind: String}", {
        taskKind: effectiveKinds[0]!,
      });
    } else {
      queryBuilder.where("task_kind IN {taskKinds: Array(String)}", {
        taskKinds: effectiveKinds,
      });
    }
  }
}
