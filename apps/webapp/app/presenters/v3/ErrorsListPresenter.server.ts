import { z } from "zod";
import { type ClickHouse } from "@internal/clickhouse";
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
export type ErrorHourlyOccurrences = Awaited<
  ReturnType<ErrorsListPresenter["getHourlyOccurrences"]>
>;
export type ErrorHourlyActivity = ErrorHourlyOccurrences[string];

// Cursor for error groups pagination
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
  // ClickHouse returns 'YYYY-MM-DD HH:mm:ss.SSS' in UTC
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
      defaultPeriod: defaultPeriod ?? "7d",
    });

    let effectiveFrom = time.from;
    let effectiveTo = time.to;

    // Apply retention limit if provided
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

    // Calculate days parameter for ClickHouse query
    const now = new Date();
    const daysAgo = effectiveFrom
      ? Math.ceil((now.getTime() - effectiveFrom.getTime()) / (1000 * 60 * 60 * 24))
      : 30;

    // Query the pre-aggregated errors_v1 table
    const queryBuilder = this.clickhouse.errors.listQueryBuilder();

    // Apply base WHERE filters
    queryBuilder.where("organization_id = {organizationId: String}", { organizationId });
    queryBuilder.where("project_id = {projectId: String}", { projectId });
    queryBuilder.where("environment_id = {environmentId: String}", { environmentId });

    // Task filter (task_identifier is part of the key, so use WHERE)
    if (tasks && tasks.length > 0) {
      queryBuilder.where("task_identifier IN {tasks: Array(String)}", { tasks });
    }

    // Group by key columns to merge partial aggregations
    queryBuilder.groupBy("error_fingerprint, task_identifier");

    // Time range filter
    queryBuilder.having("max(last_seen_date) >= now() - INTERVAL {days: Int64} DAY", {
      days: daysAgo,
    });

    // Search filter - searches in error type and message
    if (search && search.trim() !== "") {
      const searchTerm = escapeClickHouseString(search.trim()).toLowerCase();
      queryBuilder.having(
        "(lower(any(error_type)) like {searchPattern: String} OR lower(any(error_message)) like {searchPattern: String})",
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

    // Build next cursor from the last item
    let nextCursor: string | undefined;
    if (hasMore && errorGroups.length > 0) {
      const lastError = errorGroups[errorGroups.length - 1];
      nextCursor = encodeCursor({
        occurrenceCount: lastError.occurrence_count,
        fingerprint: lastError.error_fingerprint,
      });
    }

    // Transform results
    const transformedErrorGroups = errorGroups.map((error) => ({
      errorType: error.error_type,
      errorMessage: error.error_message,
      fingerprint: error.error_fingerprint,
      taskIdentifier: error.task_identifier,
      firstSeen: parseClickHouseDateTime(error.first_seen),
      lastSeen: parseClickHouseDateTime(error.last_seen),
      count: error.occurrence_count,
      sampleRunId: error.sample_run_id,
      sampleFriendlyId: error.sample_friendly_id,
    }));

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
        hasFilters,
        possibleTasks,
        wasClampedByRetention,
      },
    };
  }

  public async getHourlyOccurrences(
    organizationId: string,
    projectId: string,
    environmentId: string,
    fingerprints: string[]
  ): Promise<Record<string, Array<{ date: Date; count: number }>>> {
    if (fingerprints.length === 0) {
      return {};
    }

    const hours = 24;

    const [queryError, records] = await this.clickhouse.errors.getHourlyOccurrences({
      organizationId,
      projectId,
      environmentId,
      fingerprints,
      hours,
    });

    if (queryError) {
      throw queryError;
    }

    // Build 24 hourly buckets as epoch seconds (UTC, floored to hour)
    const buckets: number[] = [];
    const nowMs = Date.now();
    for (let i = hours - 1; i >= 0; i--) {
      const hourStart = Math.floor((nowMs - i * 3_600_000) / 3_600_000) * 3_600;
      buckets.push(hourStart);
    }

    // Index ClickHouse results by fingerprint → epoch → count
    const grouped = new Map<string, Map<number, number>>();
    for (const row of records ?? []) {
      let byHour = grouped.get(row.error_fingerprint);
      if (!byHour) {
        byHour = new Map();
        grouped.set(row.error_fingerprint, byHour);
      }
      byHour.set(row.hour_epoch, row.count);
    }

    const result: Record<string, Array<{ date: Date; count: number }>> = {};
    for (const fp of fingerprints) {
      const byHour = grouped.get(fp);
      result[fp] = buckets.map((epoch) => ({
        date: new Date(epoch * 1000),
        count: byHour?.get(epoch) ?? 0,
      }));
    }

    return result;
  }
}
