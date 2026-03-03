import { z } from "zod";
import {
  type ClickHouse,
  type TimeGranularity,
  detectTimeGranularity,
  granularityToInterval,
  granularityToStepMs,
} from "@internal/clickhouse";
import { type PrismaClientOrTransaction } from "@trigger.dev/database";
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

const DEFAULT_PAGE_SIZE = 50;

export type ErrorsList = Awaited<ReturnType<ErrorsListPresenter["call"]>>;
export type ErrorGroup = ErrorsList["errorGroups"][0];
export type ErrorsListAppliedFilters = ErrorsList["filters"];
export type ErrorOccurrences = Awaited<ReturnType<ErrorsListPresenter["getOccurrences"]>>;
export type ErrorOccurrenceActivity = ErrorOccurrences["data"][string];

type ErrorGroupCursor = {
  occurrenceCount: number;
  fingerprint: string;
};

const ErrorGroupCursorSchema = z.object({
  occurrenceCount: z.number(),
  fingerprint: z.string(),
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
      period,
      search,
      from,
      to,
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
      (search !== undefined && search !== "") ||
      !time.isDefault;

    const possibleTasksAsync = getAllTaskIdentifiers(this.replica, environmentId);

    const [possibleTasks, displayableEnvironment] = await Promise.all([
      possibleTasksAsync,
      findDisplayableEnvironment(environmentId, userId),
    ]);

    if (!displayableEnvironment) {
      throw new ServiceValidationError("No environment found");
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

    // Cursor-based pagination (sorted by occurrence_count DESC)
    const decodedCursor = cursor ? decodeCursor(cursor) : null;
    if (decodedCursor) {
      queryBuilder.having(
        "(occurrence_count < {cursorOccurrenceCount: UInt64} OR (occurrence_count = {cursorOccurrenceCount: UInt64} AND error_fingerprint < {cursorFingerprint: String}))",
        {
          cursorOccurrenceCount: decodedCursor.occurrenceCount,
          cursorFingerprint: decodedCursor.fingerprint,
        }
      );
    }

    queryBuilder.orderBy("occurrence_count DESC, error_fingerprint DESC");
    queryBuilder.limit(pageSize + 1);

    const [queryError, records] = await queryBuilder.execute();

    if (queryError) {
      throw queryError;
    }

    const results = records || [];
    const hasMore = results.length > pageSize;
    const errorGroups = results.slice(0, pageSize);

    let nextCursor: string | undefined;
    if (hasMore && errorGroups.length > 0) {
      const lastError = errorGroups[errorGroups.length - 1];
      nextCursor = encodeCursor({
        occurrenceCount: lastError.occurrence_count,
        fingerprint: lastError.error_fingerprint,
      });
    }

    // Fetch global first_seen / last_seen from the errors_v1 summary table
    const fingerprints = errorGroups.map((e) => e.error_fingerprint);
    const globalSummaryMap = await this.getGlobalSummary(
      organizationId,
      projectId,
      environmentId,
      fingerprints
    );

    const transformedErrorGroups = errorGroups.map((error) => {
      const global = globalSummaryMap.get(error.error_fingerprint);
      return {
        errorType: error.error_type,
        errorMessage: error.error_message,
        fingerprint: error.error_fingerprint,
        taskIdentifier: error.task_identifier,
        firstSeen: global?.firstSeen ?? new Date(),
        lastSeen: global?.lastSeen ?? new Date(),
        count: error.occurrence_count,
      };
    });

    return {
      errorGroups: transformedErrorGroups,
      pagination: {
        hasMore,
        nextCursor,
      },
      filters: {
        tasks,
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
    granularity: TimeGranularity;
    data: Record<string, Array<{ date: Date; count: number }>>;
  }> {
    if (fingerprints.length === 0) {
      return { granularity: "hours", data: {} };
    }

    const granularity = detectTimeGranularity(from, to);
    const intervalExpr = granularityToInterval(granularity);
    const stepMs = granularityToStepMs(granularity);

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
    const startEpoch = Math.floor(from.getTime() / stepMs) * (stepMs / 1000);
    const endEpoch = Math.ceil(to.getTime() / 1000);
    for (let epoch = startEpoch; epoch <= endEpoch; epoch += stepMs / 1000) {
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

    return { granularity, data };
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
      result.set(record.error_fingerprint, {
        firstSeen: parseClickHouseDateTime(record.first_seen),
        lastSeen: parseClickHouseDateTime(record.last_seen),
      });
    }

    return result;
  }
}
