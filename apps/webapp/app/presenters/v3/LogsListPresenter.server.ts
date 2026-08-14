import { type ClickHouse, type WhereCondition } from "@internal/clickhouse";
import { type PrismaClientOrTransaction } from "@trigger.dev/database";
import { z } from "zod";
import { EVENT_STORE_TYPES, getConfiguredEventRepository } from "~/v3/eventRepository/index.server";

import { type Direction } from "~/components/ListPagination";
import { timeFilterFromTo } from "~/components/runs/v3/SharedFilters";
import { env } from "~/env.server";
import { findDisplayableEnvironment } from "~/models/runtimeEnvironment.server";
import { getTaskIdentifiers } from "~/models/task.server";
import { BasePresenter } from "~/presenters/v3/basePresenter.server";
import { kindToLevel, type LogLevel, LogLevelSchema } from "~/utils/logUtils";
import {
  convertClickhouseDateTime64ToJsDate,
  convertDateToClickhouseDateTime,
} from "~/v3/eventRepository/clickhouseEventRepository.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import {
  escapeClickHouseLike,
  hasMinimumLogsSearchLength,
  LOGS_SEARCH_RETRY_OVERFETCH_FACTOR,
  MIN_LOGS_SEARCH_LENGTH,
  normalizeLogsSearchTerm,
  prepareLogsSearchPage,
} from "~/utils/logSearch";

export type { LogLevel };

export type LogsListOptions = {
  userId?: string;
  projectId: string;
  // filters
  tasks?: string[];
  runId?: string;
  period?: string;
  from?: number;
  to?: number;
  levels?: LogLevel[];
  defaultPeriod?: string;
  retentionLimitDays?: number;
  // search
  search?: string;
  // pagination
  direction?: Direction;
  cursor?: string;
  pageSize?: number;
};

export const LogsListOptionsSchema = z.object({
  userId: z.string().optional(),
  projectId: z.string(),
  tasks: z.array(z.string()).optional(),
  runId: z.string().optional(),
  period: z.string().optional(),
  from: z.number().int().nonnegative().optional(),
  to: z.number().int().nonnegative().optional(),
  levels: z.array(LogLevelSchema).optional(),
  defaultPeriod: z.string().optional(),
  retentionLimitDays: z.number().int().positive().optional(),
  search: z.string().max(1000).optional(),
  direction: z.enum(["forward", "backward"]).optional(),
  cursor: z.string().optional(),
  pageSize: z.number().int().positive().max(1000).optional(),
});

type LogsList = Awaited<ReturnType<LogsListPresenter["call"]>>;
export type LogEntry = LogsList["logs"][0];

// Bump when the cursor shape changes so stale cursors are ignored (reset to the first page)
// rather than misparsed.
const LOG_CURSOR_VERSION = 4;

// Cursor is a base64 encoded JSON of the pagination keys
type LogCursor = {
  v: number;
  organizationId: string;
  environmentId: string;
  triggeredTimestamp: string; // DateTime64(9) string
  traceId: string;
  spanId: string;
  projectionFingerprint?: string;
};

const LogCursorSchema = z.object({
  v: z.literal(LOG_CURSOR_VERSION),
  organizationId: z.string(),
  environmentId: z.string(),
  triggeredTimestamp: z.string(),
  traceId: z.string(),
  spanId: z.string(),
  projectionFingerprint: z.string().optional(),
});

function encodeCursor(cursor: LogCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64");
}

function decodeCursor(cursor: string): LogCursor | null {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    const validated = LogCursorSchema.safeParse(parsed);
    if (!validated.success) {
      return null;
    }
    return validated.data;
  } catch {
    return null;
  }
}

// Convert display level to ClickHouse kinds and statuses
function levelToKindsAndStatuses(level: LogLevel): { kinds?: string[]; statuses?: string[] } {
  switch (level) {
    case "TRACE":
      return { kinds: ["SPAN"] };
    case "DEBUG":
      return { kinds: ["LOG_DEBUG"] };
    case "INFO":
      return { kinds: ["LOG_INFO", "LOG_LOG"] };
    case "WARN":
      return { kinds: ["LOG_WARN"] };
    case "ERROR":
      return { kinds: ["LOG_ERROR", "SPAN_EVENT"], statuses: ["ERROR"] };
  }
}

export class LogsListPresenter extends BasePresenter {
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
      runId,
      period,
      levels,
      search,
      from,
      to,
      cursor,
      pageSize = env.LOGS_LIST_DEFAULT_PAGE_SIZE,
      defaultPeriod,
      retentionLimitDays,
    }: LogsListOptions
  ) {
    const time = timeFilterFromTo({
      period,
      from,
      to,
      defaultPeriod: defaultPeriod ?? "1h",
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
      (runId !== undefined && runId !== "") ||
      (levels !== undefined && levels.length > 0) ||
      (search !== undefined && search !== "") ||
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

    if (!displayableEnvironment) {
      throw new ServiceValidationError("No environment found");
    }

    // Determine which store to use based on organization configuration
    const { store } = await getConfiguredEventRepository(organizationId);

    // Throw error if postgres is detected
    if (store === EVENT_STORE_TYPES.POSTGRES) {
      throw new ServiceValidationError(
        "Logs are not available for PostgreSQL event store. Please contact support."
      );
    }

    if (store === EVENT_STORE_TYPES.CLICKHOUSE) {
      throw new ServiceValidationError(
        "Logs are not available for ClickHouse event store. Please contact support."
      );
    }

    const effectivePageSize = Math.min(pageSize, env.LOGS_LIST_MAX_PAGE_SIZE);
    const usesV2Search = env.LOGS_SEARCH_TABLE_VERSION === "v2";
    const queryLimit = usesV2Search
      ? (effectivePageSize + 1) * LOGS_SEARCH_RETRY_OVERFETCH_FACTOR
      : effectivePageSize + 1;

    // Only honor a cursor scoped to this org+env; one copied from another scope would shift the
    // pagination anchor instead of resetting to the first page.
    const parsedCursor = cursor ? decodeCursor(cursor) : null;
    const decodedCursor =
      parsedCursor &&
      parsedCursor.organizationId === organizationId &&
      parsedCursor.environmentId === environmentId
        ? parsedCursor
        : null;

    // Effective upper bound, always clamped to now so a request never runs [floor, +inf).
    const now = new Date();
    const clampedTo = effectiveTo !== undefined ? (effectiveTo > now ? now : effectiveTo) : now;

    const rawSearchTerm = search?.trim() ?? "";
    const normalizedSearchTerm = usesV2Search
      ? normalizeLogsSearchTerm(rawSearchTerm)
      : rawSearchTerm.toLocaleLowerCase();
    if (rawSearchTerm !== "" && !hasMinimumLogsSearchLength(normalizedSearchTerm)) {
      throw new ServiceValidationError(
        `Log searches must be at least ${MIN_LOGS_SEARCH_LENGTH} characters.`
      );
    }
    const searchTerm =
      normalizedSearchTerm === "" ? undefined : escapeClickHouseLike(normalizedSearchTerm);

    // Run exactly one bounded query. Broadening a search window is an explicit user action;
    // silently rescanning the same recent rows makes absence queries needlessly expensive.
    const runQuery = () => {
      const queryBuilder = this.clickhouse.taskEventsSearch.logsListQueryBuilder(
        env.LOGS_SEARCH_TABLE_VERSION
      );

      // The materialized view excludes events without a trace_id; this guards the legacy tail.
      queryBuilder.where("trace_id != ''");
      queryBuilder.where("environment_id = {environmentId: String}", { environmentId });
      queryBuilder.where("organization_id = {organizationId: String}", { organizationId });
      queryBuilder.where("project_id = {projectId: String}", { projectId });

      if (clampedTo) {
        queryBuilder.where("triggered_timestamp <= {triggeredAtEnd: DateTime64(3)}", {
          triggeredAtEnd: convertDateToClickhouseDateTime(clampedTo),
        });
      }

      if (effectiveFrom) {
        queryBuilder.where("triggered_timestamp >= {triggeredAtStart: DateTime64(3)}", {
          triggeredAtStart: convertDateToClickhouseDateTime(effectiveFrom),
        });
      }

      // Task filter (applies directly to ClickHouse)
      if (tasks && tasks.length > 0) {
        queryBuilder.where("task_identifier IN {tasks: Array(String)}", { tasks });
      }

      // Run ID filter
      if (runId && runId !== "") {
        queryBuilder.where("run_id = {runId: String}", { runId });
      }

      if (searchTerm !== undefined) {
        if (usesV2Search) {
          // One predicate lets the text index answer substring searches without an OR across
          // independently indexed columns.
          queryBuilder.where("search_text LIKE {searchPattern: String}", {
            searchPattern: `%${searchTerm}%`,
          });
        } else {
          queryBuilder.where(
            "(lowerUTF8(message) LIKE {searchPattern: String} OR lowerUTF8(attributes_text) LIKE {searchPattern: String})",
            { searchPattern: `%${searchTerm}%` }
          );
        }
      }

      if (levels && levels.length > 0) {
        const conditions: WhereCondition[] = [];

        for (let i = 0; i < levels.length; i++) {
          const filter = levelToKindsAndStatuses(levels[i]);

          if (filter.kinds && filter.kinds.length > 0) {
            conditions.push({
              clause: `kind IN {kinds_${i}: Array(String)} AND status NOT IN {excluded_statuses: Array(String)}`,
              params: {
                [`kinds_${i}`]: filter.kinds,
                excluded_statuses: ["ERROR", "CANCELLED"],
              },
            });
          }

          if (filter.statuses && filter.statuses.length > 0) {
            conditions.push({
              clause: `status IN {statuses_${i}: Array(String)}`,
              params: { [`statuses_${i}`]: filter.statuses },
            });
          }
        }

        queryBuilder.whereOr(conditions);
      }

      // Keyset pagination over the sort key. ORDER BY is DESC, so the next page is the rows
      // that sort after the cursor (strictly less-than). V2 adds the projection identity as the
      // final tiebreaker so retry copies and distinct rows at a span boundary paginate safely.
      if (decodedCursor) {
        const cursorParams = {
          cursorTriggeredTimestamp: decodedCursor.triggeredTimestamp,
          cursorTraceId: decodedCursor.traceId,
          cursorSpanId: decodedCursor.spanId,
          ...(usesV2Search && decodedCursor.projectionFingerprint
            ? { cursorProjectionFingerprint: decodedCursor.projectionFingerprint }
            : {}),
        };
        queryBuilder.where(
          usesV2Search && decodedCursor.projectionFingerprint
            ? `(triggered_timestamp < {cursorTriggeredTimestamp: String}
              OR (triggered_timestamp = {cursorTriggeredTimestamp: String} AND trace_id < {cursorTraceId: String})
              OR (triggered_timestamp = {cursorTriggeredTimestamp: String} AND trace_id = {cursorTraceId: String} AND span_id < {cursorSpanId: String})
              OR (triggered_timestamp = {cursorTriggeredTimestamp: String} AND trace_id = {cursorTraceId: String} AND span_id = {cursorSpanId: String} AND projection_fingerprint < {cursorProjectionFingerprint: UInt128}))`
            : `(triggered_timestamp < {cursorTriggeredTimestamp: String}
              OR (triggered_timestamp = {cursorTriggeredTimestamp: String} AND trace_id < {cursorTraceId: String})
              OR (triggered_timestamp = {cursorTriggeredTimestamp: String} AND trace_id = {cursorTraceId: String} AND span_id < {cursorSpanId: String}))`,
          cursorParams
        );
      }

      queryBuilder.orderBy(
        usesV2Search
          ? "triggered_timestamp DESC, trace_id DESC, span_id DESC, projection_fingerprint DESC"
          : "triggered_timestamp DESC, trace_id DESC, span_id DESC"
      );
      queryBuilder.limit(queryLimit);

      return queryBuilder.execute();
    };

    const [queryError, queryResult] = await runQuery();
    if (queryError) {
      throw queryError;
    }

    // ClickHouse's break overflow modes can return a short prefix without a reliable completion
    // marker. Keep the default throw behavior so the product never presents truncated results as
    // complete.
    const results = queryResult ?? [];
    const page = usesV2Search
      ? prepareLogsSearchPage(results, effectivePageSize, queryLimit)
      : {
          rows: results.slice(0, effectivePageSize),
          hasMore: results.length > effectivePageSize,
        };
    const hasMore = page.hasMore;
    const logs = page.rows;

    // Build next cursor from the last item
    let nextCursor: string | undefined;
    if (hasMore && logs.length > 0) {
      const lastLog = logs[logs.length - 1];
      nextCursor = encodeCursor({
        v: LOG_CURSOR_VERSION,
        organizationId,
        environmentId,
        triggeredTimestamp: lastLog.triggered_timestamp,
        traceId: lastLog.trace_id,
        spanId: lastLog.span_id,
        projectionFingerprint: lastLog.projection_fingerprint_string,
      });
    }

    // Transform results
    // Use :: as separator since dash conflicts with date format in start_time
    const transformedLogs = logs.map((log) => {
      let displayMessage = log.message;

      // The search table extracts this leaf in the materialized view, so list queries never
      // need to read or parse the complete attributes blob.
      if (log.status === "ERROR" && log.error_message) {
        displayMessage = log.error_message;
      }

      return {
        id: `${log.trace_id}::${log.span_id}::${log.run_id}::${log.start_time}`,
        runId: log.run_id,
        taskIdentifier: log.task_identifier,
        startTime: convertClickhouseDateTime64ToJsDate(log.start_time).toISOString(),
        triggeredTimestamp: convertClickhouseDateTime64ToJsDate(
          log.triggered_timestamp
        ).toISOString(),
        traceId: log.trace_id,
        spanId: log.span_id,
        parentSpanId: log.parent_span_id || null,
        message: displayMessage,
        kind: log.kind,
        status: log.status,
        duration: typeof log.duration === "number" ? log.duration : Number(log.duration),
        level: kindToLevel(log.kind, log.status),
      };
    });

    return {
      logs: transformedLogs,
      pagination: {
        next: nextCursor,
        previous: undefined, // For now, only support forward pagination
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
        levels: levels || [],
        from: effectiveFrom,
        to: effectiveTo,
      },
      hasFilters,
      hasAnyLogs: transformedLogs.length > 0,
      searchTerm: search,
      searchExpansion:
        searchTerm !== undefined && time.isDefault && transformedLogs.length === 0
          ? { nextPeriod: `${Math.min(retentionLimitDays ?? 7, 7)}d` }
          : undefined,
      retention:
        retentionLimitDays !== undefined
          ? {
              limitDays: retentionLimitDays,
              wasClamped: wasClampedByRetention,
            }
          : undefined,
    };
  }
}
