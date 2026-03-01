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

// Cursor for error groups pagination
type ErrorGroupCursor = {
  lastSeen: string;
  fingerprint: string;
};

const ErrorGroupCursorSchema = z.object({
  lastSeen: z.string(),
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

    // Group by error_fingerprint to merge partial aggregations
    queryBuilder.groupBy("error_fingerprint");

    // Apply HAVING filters (filters on aggregated columns)
    // Time range filter - use last_seen_date regular column instead of aggregate
    queryBuilder.having("max(last_seen_date) >= now() - INTERVAL {days: Int64} DAY", { days: daysAgo });

    // Task filter
    if (tasks && tasks.length > 0) {
      queryBuilder.having("anyMerge(sample_task_identifier) IN {tasks: Array(String)}", { tasks });
    }

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

    // Cursor-based pagination
    const decodedCursor = cursor ? decodeCursor(cursor) : null;
    if (decodedCursor) {
      queryBuilder.having(
        "(last_seen < {cursorLastSeen: String} OR (last_seen = {cursorLastSeen: String} AND error_fingerprint < {cursorFingerprint: String}))",
        {
          cursorLastSeen: decodedCursor.lastSeen,
          cursorFingerprint: decodedCursor.fingerprint,
        }
      );
    }

    queryBuilder.orderBy("last_seen DESC, error_fingerprint DESC");
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
        lastSeen: lastError.last_seen,
        fingerprint: lastError.error_fingerprint,
      });
    }

    // Transform results
    const transformedErrorGroups = errorGroups.map((error) => ({
      errorType: error.error_type,
      errorMessage: error.error_message,
      fingerprint: error.error_fingerprint,
      firstSeen: new Date(parseInt(error.first_seen) * 1000),
      lastSeen: new Date(parseInt(error.last_seen) * 1000),
      count: error.occurrence_count,
      affectedTasks: error.affected_tasks,
      sampleRunId: error.sample_run_id,
      sampleFriendlyId: error.sample_friendly_id,
      sampleTaskIdentifier: error.sample_task_identifier,
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
}
