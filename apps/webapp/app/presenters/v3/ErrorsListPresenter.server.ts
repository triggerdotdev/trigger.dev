import { z } from "zod";
import { type ClickHouse, msToClickHouseInterval } from "@internal/clickhouse";
import { TimeGranularity } from "~/utils/timeGranularity";

const errorsListGranularity = new TimeGranularity([
  { max: "2h", granularity: "1m" },
  { max: "2d", granularity: "1h" },
  { max: "2w", granularity: "1d" },
  { max: "3 months", granularity: "1w" },
  { max: "Infinity", granularity: "30d" },
]);
import { type ErrorGroupStatus, type PrismaClientOrTransaction } from "@trigger.dev/database";
import { type Direction } from "~/components/ListPagination";
import { timeFilterFromTo } from "~/components/runs/v3/SharedFilters";
import { findDisplayableEnvironment } from "~/models/runtimeEnvironment.server";
import { getAllTaskIdentifiers } from "~/models/task.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { BasePresenter } from "~/presenters/v3/basePresenter.server";

export type ErrorsListOptions = {
  userId?: string;
  projectId: string;
  // filters
  tasks?: string[];
  versions?: string[];
  statuses?: ErrorGroupStatus[];
  period?: string;
  from?: number;
  to?: number;
  defaultPeriod?: string;
  retentionLimitDays?: number;
  // search
  search?: string;
  // pagination
  direction?: Direction;
  cursor?: string;
  pageSize?: number;
};

export const ErrorsListOptionsSchema = z.object({
  userId: z.string().optional(),
  projectId: z.string(),
  tasks: z.array(z.string()).optional(),
  versions: z.array(z.string()).optional(),
  statuses: z.array(z.enum(["UNRESOLVED", "RESOLVED", "IGNORED"])).optional(),
  period: z.string().optional(),
  from: z.number().int().nonnegative().optional(),
  to: z.number().int().nonnegative().optional(),
  defaultPeriod: z.string().optional(),
  retentionLimitDays: z.number().int().positive().optional(),
  search: z.string().max(1000).optional(),
  direction: z.enum(["forward", "backward"]).optional(),
  cursor: z.string().optional(),
  pageSize: z.number().int().positive().max(1000).optional(),
});

const DEFAULT_PAGE_SIZE = 25;

export type ErrorsList = Awaited<ReturnType<ErrorsListPresenter["call"]>>;
export type ErrorGroup = ErrorsList["errorGroups"][0];
export type ErrorsListAppliedFilters = ErrorsList["filters"];
export type ErrorOccurrences = Awaited<ReturnType<ErrorsListPresenter["getOccurrences"]>>;
export type ErrorOccurrenceActivity = ErrorOccurrences["data"][string];

type ErrorGroupCursor = {
  occurrenceCount: number;
  fingerprint: string;
  taskIdentifier: string;
};

const ErrorGroupCursorSchema = z.object({
  occurrenceCount: z.number(),
  fingerprint: z.string(),
  taskIdentifier: z.string(),
});

function encodeCursor(cursor: ErrorGroupCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64");
}

function decodeCursor(cursor: string): ErrorGroupCursor | null {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    const validated = ErrorGroupCursorSchema.safeParse(parsed);
    if (!validated.success) {
      return null;
    }
    return validated.data as ErrorGroupCursor;
  } catch {
    return null;
  }
}

function cursorFromRow(row: {
  occurrence_count: number;
  error_fingerprint: string;
  task_identifier: string;
}): string {
  return encodeCursor({
    occurrenceCount: row.occurrence_count,
    fingerprint: row.error_fingerprint,
    taskIdentifier: row.task_identifier,
  });
}

function parseClickHouseDateTime(value: string): Date {
  const asNum = Number(value);
  if (!isNaN(asNum) && asNum > 1e12) {
    return new Date(asNum);
  }
  return new Date(value.replace(" ", "T") + "Z");
}

function escapeClickHouseString(val: string): string {
  return val.replace(/\\/g, "\\\\").replace(/\//g, "\\/").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export class ErrorsListPresenter extends BasePresenter {
  constructor(
    private readonly replica: PrismaClientOrTransaction,
    private readonly clickhouse: ClickHouse
  ) {
    super(undefined, replica);
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
      period,
      search,
      from,
      to,
      direction,
      cursor,
      pageSize = DEFAULT_PAGE_SIZE,
      defaultPeriod,
      retentionLimitDays,
    }: ErrorsListOptions
  ) {
    const time = timeFilterFromTo({
      period,
      from,
      to,
      defaultPeriod: defaultPeriod ?? "1d",
    });

    let effectiveFrom = time.from;
    let effectiveTo = time.to;

    let wasClampedByRetention = false;
    if (retentionLimitDays !== undefined && effectiveFrom) {
      const retentionCutoffDate = new Date(Date.now() - retentionLimitDays * 24 * 60 * 60 * 1000);

      if (effectiveFrom < retentionCutoffDate) {
        effectiveFrom = retentionCutoffDate;
        wasClampedByRetention = true;
      }
    }

    const hasFilters =
      (tasks !== undefined && tasks.length > 0) ||
      (versions !== undefined && versions.length > 0) ||
      (search !== undefined && search !== "") ||
      (statuses !== undefined && statuses.length > 0);

    const possibleTasksAsync = getAllTaskIdentifiers(this.replica, environmentId);

    // Pre-filter by status: since status lives in Postgres (ErrorGroupState) and the error
    // list comes from ClickHouse, we resolve inclusion/exclusion sets upfront so that
    // ClickHouse pagination operates on the correctly filtered dataset.
    const statusFilterAsync = this.resolveStatusFilter(environmentId, statuses);

    const [possibleTasks, displayableEnvironment, statusFilter] = await Promise.all([
      possibleTasksAsync,
      findDisplayableEnvironment(environmentId, userId),
      statusFilterAsync,
    ]);

    if (!displayableEnvironment) {
      throw new ServiceValidationError("No environment found");
    }

    if (statusFilter.empty) {
      return {
        errorGroups: [],
        pagination: {
          next: undefined,
          previous: undefined,
        },
        filters: {
          tasks,
          versions,
          statuses,
          search,
          period: time,
          from: effectiveFrom,
          to: effectiveTo,
          hasFilters,
          possibleTasks,
          wasClampedByRetention,
        },
      };
    }

    // Query the per-minute error_occurrences_v1 table for time-scoped counts
    const queryBuilder = this.clickhouse.errors.occurrencesListQueryBuilder();

    queryBuilder.where("organization_id = {organizationId: String}", { organizationId });
    queryBuilder.where("project_id = {projectId: String}", { projectId });
    queryBuilder.where("environment_id = {environmentId: String}", { environmentId });

    // Precise time range filtering via WHERE on the minute column
    queryBuilder.where("minute >= toStartOfMinute(fromUnixTimestamp64Milli({fromTimeMs: Int64}))", {
      fromTimeMs: effectiveFrom.getTime(),
    });
    queryBuilder.where("minute <= toStartOfMinute(fromUnixTimestamp64Milli({toTimeMs: Int64}))", {
      toTimeMs: effectiveTo.getTime(),
    });

    if (tasks && tasks.length > 0) {
      queryBuilder.where("task_identifier IN {tasks: Array(String)}", { tasks });
    }

    if (versions && versions.length > 0) {
      queryBuilder.where("task_version IN {versions: Array(String)}", { versions });
    }

    if (statusFilter.includeKeys) {
      queryBuilder.where(
        "concat(task_identifier, '::', error_fingerprint) IN ({statusIncludeKeys: Array(String)})",
        { statusIncludeKeys: statusFilter.includeKeys }
      );
    }
    if (statusFilter.excludeKeys) {
      queryBuilder.where(
        "concat(task_identifier, '::', error_fingerprint) NOT IN ({statusExcludeKeys: Array(String)})",
        { statusExcludeKeys: statusFilter.excludeKeys }
      );
    }

    queryBuilder.groupBy("error_fingerprint, task_identifier");

    // Text search via HAVING (operates on aggregated values)
    if (search && search.trim() !== "") {
      const searchTerm = escapeClickHouseString(search.trim()).toLowerCase();
      queryBuilder.having(
        "(lower(error_type) like {searchPattern: String} OR lower(error_message) like {searchPattern: String})",
        {
          searchPattern: `%${searchTerm}%`,
        }
      );
    }

    const isBackward = direction === "backward";
    const decodedCursor = cursor ? decodeCursor(cursor) : null;

    if (decodedCursor) {
      const cmp = isBackward ? ">" : "<";
      queryBuilder.having(
        `(occurrence_count ${cmp} {cursorOccurrenceCount: UInt64}
          OR (occurrence_count = {cursorOccurrenceCount: UInt64} AND error_fingerprint ${cmp} {cursorFingerprint: String})
          OR (occurrence_count = {cursorOccurrenceCount: UInt64} AND error_fingerprint = {cursorFingerprint: String} AND task_identifier ${cmp} {cursorTaskIdentifier: String}))`,
        {
          cursorOccurrenceCount: decodedCursor.occurrenceCount,
          cursorFingerprint: decodedCursor.fingerprint,
          cursorTaskIdentifier: decodedCursor.taskIdentifier,
        }
      );
    }

    const sortDir = isBackward ? "ASC" : "DESC";
    queryBuilder.orderBy(
      `occurrence_count ${sortDir}, error_fingerprint ${sortDir}, task_identifier ${sortDir}`
    );
    queryBuilder.limit(pageSize + 1);

    const [queryError, records] = await queryBuilder.execute();

    if (queryError) {
      throw queryError;
    }

    const results = records || [];
    const hasMore = results.length > pageSize;
    const page = results.slice(0, pageSize);

    if (isBackward) {
      page.reverse();
    }

    let nextCursor: string | undefined;
    let previousCursor: string | undefined;

    if (isBackward) {
      previousCursor = hasMore && page.length > 0 ? cursorFromRow(page[0]) : undefined;
      nextCursor = page.length > 0 ? cursorFromRow(page[page.length - 1]) : undefined;
    } else {
      previousCursor = decodedCursor && page.length > 0 ? cursorFromRow(page[0]) : undefined;
      nextCursor = hasMore && page.length > 0 ? cursorFromRow(page[page.length - 1]) : undefined;
    }

    const errorGroups = page;

    // Fetch global first_seen / last_seen from the errors_v1 summary table
    const fingerprints = errorGroups.map((e) => e.error_fingerprint);
    const [globalSummaryMap, stateMap] = await Promise.all([
      this.getGlobalSummary(organizationId, projectId, environmentId, fingerprints),
      this.getErrorGroupStates(environmentId, errorGroups),
    ]);

    let transformedErrorGroups = errorGroups.map((error) => {
      const global = globalSummaryMap.get(error.error_fingerprint);
      const state = stateMap.get(`${error.task_identifier}:${error.error_fingerprint}`);
      return {
        errorType: error.error_type,
        errorMessage: error.error_message,
        fingerprint: error.error_fingerprint,
        taskIdentifier: error.task_identifier,
        firstSeen: global?.firstSeen ?? new Date(),
        lastSeen: global?.lastSeen ?? new Date(),
        count: error.occurrence_count,
        status: state?.status ?? "UNRESOLVED",
        resolvedAt: state?.resolvedAt ?? null,
        ignoredUntil: state?.ignoredUntil ?? null,
      };
    });

    return {
      errorGroups: transformedErrorGroups,
      pagination: {
        next: nextCursor,
        previous: previousCursor,
      },
      filters: {
        tasks,
        versions,
        statuses,
        search,
        period: time,
        from: effectiveFrom,
        to: effectiveTo,
        hasFilters,
        possibleTasks,
        wasClampedByRetention,
      },
    };
  }

  /**
   * Returns bucketed occurrence counts for the given fingerprints over a time range.
   * Granularity is determined automatically from the range span.
   */
  public async getOccurrences(
    organizationId: string,
    projectId: string,
    environmentId: string,
    fingerprints: string[],
    from: Date,
    to: Date
  ): Promise<{
    data: Record<string, Array<{ date: Date; count: number }>>;
  }> {
    if (fingerprints.length === 0) {
      return { data: {} };
    }

    const granularityMs = errorsListGranularity.getTimeGranularityMs(from, to);
    const intervalExpr = msToClickHouseInterval(granularityMs);

    const queryBuilder = this.clickhouse.errors.createOccurrencesQueryBuilder(intervalExpr);

    queryBuilder.where("organization_id = {organizationId: String}", { organizationId });
    queryBuilder.where("project_id = {projectId: String}", { projectId });
    queryBuilder.where("environment_id = {environmentId: String}", { environmentId });
    queryBuilder.where("error_fingerprint IN {fingerprints: Array(String)}", { fingerprints });
    queryBuilder.where("minute >= toStartOfMinute(fromUnixTimestamp64Milli({fromTimeMs: Int64}))", {
      fromTimeMs: from.getTime(),
    });
    queryBuilder.where("minute <= toStartOfMinute(fromUnixTimestamp64Milli({toTimeMs: Int64}))", {
      toTimeMs: to.getTime(),
    });

    queryBuilder.groupBy("error_fingerprint, bucket_epoch");
    queryBuilder.orderBy("error_fingerprint ASC, bucket_epoch ASC");

    const [queryError, records] = await queryBuilder.execute();

    if (queryError) {
      throw queryError;
    }

    // Build time buckets covering the full range
    const buckets: number[] = [];
    const startEpoch = Math.floor(from.getTime() / granularityMs) * (granularityMs / 1000);
    const endEpoch = Math.ceil(to.getTime() / 1000);
    for (let epoch = startEpoch; epoch <= endEpoch; epoch += granularityMs / 1000) {
      buckets.push(epoch);
    }

    // Index results by fingerprint -> epoch -> count
    const grouped = new Map<string, Map<number, number>>();
    for (const row of records ?? []) {
      let byBucket = grouped.get(row.error_fingerprint);
      if (!byBucket) {
        byBucket = new Map();
        grouped.set(row.error_fingerprint, byBucket);
      }
      byBucket.set(row.bucket_epoch, (byBucket.get(row.bucket_epoch) ?? 0) + row.count);
    }

    const data: Record<string, Array<{ date: Date; count: number }>> = {};
    for (const fp of fingerprints) {
      const byBucket = grouped.get(fp);
      data[fp] = buckets.map((epoch) => ({
        date: new Date(epoch * 1000),
        count: byBucket?.get(epoch) ?? 0,
      }));
    }

    return { data };
  }

  /**
   * Determines which (task, fingerprint) pairs to include or exclude from the ClickHouse
   * query based on the requested status filter. Since status lives in Postgres and errors
   * live in ClickHouse, we resolve the filter set here so ClickHouse pagination is correct.
   *
   * - UNRESOLVED is the default (no ErrorGroupState row), so filtering FOR it means
   *   excluding groups with non-matching explicit statuses.
   * - RESOLVED/IGNORED are explicit, so filtering for them means including only matching groups.
   */
  private async resolveStatusFilter(
    environmentId: string,
    statuses?: ErrorGroupStatus[]
  ): Promise<{
    includeKeys?: string[];
    excludeKeys?: string[];
    empty: boolean;
  }> {
    if (!statuses || statuses.length === 0) {
      return { empty: false };
    }

    const allStatuses: ErrorGroupStatus[] = ["UNRESOLVED", "RESOLVED", "IGNORED"];
    const excludedStatuses = allStatuses.filter((s) => !statuses.includes(s));

    if (excludedStatuses.length === 0) {
      return { empty: false };
    }

    if (statuses.includes("UNRESOLVED")) {
      const excluded = await this.replica.errorGroupState.findMany({
        where: { environmentId, status: { in: excludedStatuses } },
        select: { taskIdentifier: true, errorFingerprint: true },
      });
      if (excluded.length === 0) {
        return { empty: false };
      }
      return {
        excludeKeys: excluded.map((g) => `${g.taskIdentifier}::${g.errorFingerprint}`),
        empty: false,
      };
    }

    const included = await this.replica.errorGroupState.findMany({
      where: { environmentId, status: { in: statuses } },
      select: { taskIdentifier: true, errorFingerprint: true },
    });
    if (included.length === 0) {
      return { empty: true };
    }
    return {
      includeKeys: included.map((g) => `${g.taskIdentifier}::${g.errorFingerprint}`),
      empty: false,
    };
  }

  /**
   * Batch-fetch ErrorGroupState rows from Postgres for the given ClickHouse error groups.
   * Returns a map keyed by `${taskIdentifier}:${errorFingerprint}`.
   */
  private async getErrorGroupStates(
    environmentId: string,
    errorGroups: Array<{ task_identifier: string; error_fingerprint: string }>
  ) {
    type StateValue = {
      status: ErrorGroupStatus;
      resolvedAt: Date | null;
      ignoredUntil: Date | null;
    };

    const result = new Map<string, StateValue>();
    if (errorGroups.length === 0) return result;

    const states = await this.replica.errorGroupState.findMany({
      where: {
        environmentId,
        OR: errorGroups.map((e) => ({
          taskIdentifier: e.task_identifier,
          errorFingerprint: e.error_fingerprint,
        })),
      },
      select: {
        taskIdentifier: true,
        errorFingerprint: true,
        status: true,
        resolvedAt: true,
        ignoredUntil: true,
      },
    });

    for (const state of states) {
      result.set(`${state.taskIdentifier}:${state.errorFingerprint}`, {
        status: state.status,
        resolvedAt: state.resolvedAt,
        ignoredUntil: state.ignoredUntil,
      });
    }

    return result;
  }

  /**
   * Fetches global first_seen / last_seen for a set of fingerprints from errors_v1.
   */
  private async getGlobalSummary(
    organizationId: string,
    projectId: string,
    environmentId: string,
    fingerprints: string[]
  ): Promise<Map<string, { firstSeen: Date; lastSeen: Date }>> {
    const result = new Map<string, { firstSeen: Date; lastSeen: Date }>();
    if (fingerprints.length === 0) return result;

    const queryBuilder = this.clickhouse.errors.listQueryBuilder();
    queryBuilder.where("organization_id = {organizationId: String}", { organizationId });
    queryBuilder.where("project_id = {projectId: String}", { projectId });
    queryBuilder.where("environment_id = {environmentId: String}", { environmentId });
    queryBuilder.where("error_fingerprint IN {fingerprints: Array(String)}", { fingerprints });
    queryBuilder.groupBy("error_fingerprint, task_identifier");

    const [queryError, records] = await queryBuilder.execute();

    if (queryError || !records) return result;

    for (const record of records) {
      const firstSeen = parseClickHouseDateTime(record.first_seen);
      const lastSeen = parseClickHouseDateTime(record.last_seen);
      const existing = result.get(record.error_fingerprint);

      if (existing) {
        if (firstSeen < existing.firstSeen) existing.firstSeen = firstSeen;
        if (lastSeen > existing.lastSeen) existing.lastSeen = lastSeen;
      } else {
        result.set(record.error_fingerprint, { firstSeen, lastSeen });
      }
    }

    return result;
  }
}
