import {
  type ClickHouse,
  isClickhouseResourceLimitError,
  TASK_EVENT_SEARCH_MAX_TRIGGERED_AFTER_INSERT_MS,
  type WhereCondition,
} from "@internal/clickhouse";
import { type PrismaClientOrTransaction } from "@trigger.dev/database";
import { createHash } from "node:crypto";
import parseDuration from "parse-duration";
import { z } from "zod";
import { EVENT_STORE_TYPES, getConfiguredEventRepository } from "~/v3/eventRepository/index.server";

import { type Direction } from "~/components/ListPagination";
import { timeFilters } from "~/components/runs/v3/SharedFilters";
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
  hasMinimumLogsSearchLength,
  logsSearchExpansionPeriod,
  logsSearchPredicate,
  LOGS_SEARCH_RETRY_OVERFETCH_FACTOR,
  MIN_LOGS_SEARCH_LENGTH,
  normalizeLogsSearchTerm,
  prepareLogsSearchPage,
} from "~/utils/logSearch";
import { decodeLogsSearchCursor, encodeLogsSearchCursor } from "~/utils/logSearchCursor.server";
import {
  continueLogsSearchSlice,
  initialLogsSearchSlice,
  logsSearchRangeFrom,
  logsSearchRangeTo,
  rebaseLogsSearchSliceToRange,
  logsSearchRowsPerHourBucket,
  nextLogsSearchSlice,
  retryTimedOutLogsSearchSlice,
  type LogsSearchSlice,
  type LogsSearchSliceStats,
} from "~/utils/logSearchSlices";

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
type PresentedLogEntry = LogsList["logs"][0];
export type LogEntry = Omit<PresentedLogEntry, "projectionFingerprint"> & {
  projectionFingerprint?: string;
};

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
    }: LogsListOptions,
    abortSignal?: AbortSignal
  ) {
    const nowMs = Date.now();
    const effectiveDefaultPeriod = defaultPeriod ?? "1h";
    const time = timeFilters({ period, from, to, defaultPeriod: effectiveDefaultPeriod });
    const explicitFrom = time.from?.getTime();
    const explicitTo = time.to?.getTime();
    const periodMs =
      (time.period ? parseDuration(time.period) : undefined) ||
      parseDuration(effectiveDefaultPeriod) ||
      24 * 60 * 60 * 1000;

    const retentionFloor =
      retentionLimitDays === undefined
        ? undefined
        : nowMs - retentionLimitDays * 24 * 60 * 60 * 1000;

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
    const queryLimit = (effectivePageSize + 1) * LOGS_SEARCH_RETRY_OVERFETCH_FACTOR;

    const rawSearchTerm = search?.trim() ?? "";
    const normalizedSearchTerm = normalizeLogsSearchTerm(rawSearchTerm);
    const filterFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          projectId,
          tasks: [...(tasks ?? [])].sort(),
          runId: runId ?? null,
          period: time.period ?? null,
          from: explicitFrom ?? null,
          to: explicitTo ?? null,
          levels: [...(levels ?? [])].sort(),
          search: normalizedSearchTerm,
          retentionLimitDays: retentionLimitDays ?? null,
        })
      )
      .digest("base64url");

    const parsedCursor = cursor ? decodeLogsSearchCursor(cursor) : null;
    const deriveRangeFrom = (anchorTime: number, includeRetention: boolean) =>
      logsSearchRangeFrom(anchorTime, {
        periodMs,
        explicitFrom,
        retentionFloor: includeRetention ? retentionFloor : undefined,
      });
    const deriveRangeTo = (anchorTime: number) => logsSearchRangeTo(anchorTime, explicitTo);

    const scopedCursorSlice =
      parsedCursor &&
      parsedCursor.organizationId === organizationId &&
      parsedCursor.environmentId === environmentId &&
      parsedCursor.filterFingerprint === filterFingerprint
        ? parsedCursor.slice
        : undefined;
    const initialRangeFrom = deriveRangeFrom(nowMs, true);
    const initialRangeTo = deriveRangeTo(nowMs);
    const cursorAnchorTime = scopedCursorSlice?.anchorTime;
    const cursorRangeFrom =
      cursorAnchorTime === undefined ? undefined : deriveRangeFrom(cursorAnchorTime, true);
    const cursorRangeTo =
      cursorAnchorTime === undefined ? undefined : deriveRangeTo(cursorAnchorTime);
    const rebasedCursorSlice =
      scopedCursorSlice && cursorRangeFrom !== undefined && cursorRangeTo !== undefined
        ? rebaseLogsSearchSliceToRange(scopedCursorSlice, cursorRangeFrom, cursorRangeTo, nowMs)
        : undefined;
    const cursorExpired = rebasedCursorSlice === "expired";
    const cursorSlice =
      rebasedCursorSlice && rebasedCursorSlice !== "expired" ? rebasedCursorSlice : undefined;
    const useCursorAnchor = cursorSlice !== undefined || cursorExpired;
    const anchorTime = useCursorAnchor ? cursorAnchorTime! : nowMs;
    const rangeToMs = useCursorAnchor ? cursorRangeTo! : initialRangeTo;
    const rangeFromMs = useCursorAnchor ? cursorRangeFrom! : initialRangeFrom;
    const emptyRange = rangeFromMs > rangeToMs;
    const slice =
      cursorSlice ??
      initialLogsSearchSlice(
        new Date(emptyRange ? rangeToMs : rangeFromMs),
        new Date(rangeToMs),
        anchorTime
      );

    const rangeFrom = new Date(rangeFromMs);
    const rangeTo = new Date(rangeToMs);
    const querySliceFrom = Math.max(
      slice.sliceFrom,
      rangeFromMs,
      retentionFloor ?? 0,
      explicitFrom ?? 0
    );
    const querySliceTo = Math.min(slice.sliceTo, rangeToMs, nowMs);
    const wasClampedByRetention =
      retentionFloor !== undefined && rangeFromMs > deriveRangeFrom(anchorTime, false);
    if (rawSearchTerm !== "" && !hasMinimumLogsSearchLength(normalizedSearchTerm)) {
      throw new ServiceValidationError(
        `Log searches must be at least ${MIN_LOGS_SEARCH_LENGTH} characters.`
      );
    }
    const searchPredicate =
      normalizedSearchTerm === "" ? undefined : logsSearchPredicate(normalizedSearchTerm);
    const maxExecutionTime = slice.sliceIndex === 0 ? 8 : 5;
    const sliceHours = Math.max(0, slice.remainingUpper - querySliceFrom) / 3_600_000;
    const logComment = [
      "logs_list",
      `term=${searchPredicate?.kind ?? "none"}`,
      `slice=${slice.sliceIndex}`,
      `hours=${sliceHours.toFixed(2)}`,
      `rows_per_hour=${logsSearchRowsPerHourBucket(slice.rowsPerHour)}`,
    ].join(" ");

    const runQuery = () => {
      const queryBuilder = this.clickhouse.taskEventsSearch.logsListQueryBuilder({
        settings: {
          max_execution_time: maxExecutionTime,
          log_comment: logComment,
          ...(env.CLICKHOUSE_LOGS_LIST_LAZY_MATERIALIZATION
            ? {
                query_plan_optimize_lazy_materialization: 1,
                query_plan_max_limit_for_lazy_materialization: queryLimit,
              }
            : {}),
          ...(searchPredicate && searchPredicate.kind !== "word"
            ? { ignore_data_skipping_indices: "idx_search_text,idx_search_words" }
            : {}),
        },
      });

      queryBuilder.where("trace_id != ''");
      queryBuilder.where("environment_id = {environmentId: String}", { environmentId });
      queryBuilder.where("organization_id = {organizationId: String}", { organizationId });
      queryBuilder.where("project_id = {projectId: String}", { projectId });
      queryBuilder.where(
        slice.upperInclusive
          ? "triggered_timestamp <= {sliceTo: DateTime64(3)}"
          : "triggered_timestamp < {sliceTo: DateTime64(3)}",
        { sliceTo: convertDateToClickhouseDateTime(new Date(querySliceTo)) }
      );
      queryBuilder.where("triggered_timestamp >= {sliceFrom: DateTime64(3)}", {
        sliceFrom: convertDateToClickhouseDateTime(new Date(querySliceFrom)),
      });
      queryBuilder.where("inserted_at >= {insertedAtStart: DateTime64(3)}", {
        insertedAtStart: convertDateToClickhouseDateTime(
          new Date(querySliceFrom - TASK_EVENT_SEARCH_MAX_TRIGGERED_AFTER_INSERT_MS)
        ),
      });

      if (tasks && tasks.length > 0) {
        queryBuilder.where("task_identifier IN {tasks: Array(String)}", { tasks });
      }
      if (runId && runId !== "") {
        queryBuilder.where("run_id = {runId: String}", { runId });
      }

      if (searchPredicate?.kind === "word") {
        queryBuilder.where("hasAllTokens(concat(search_text, ''), {searchTokens: String})", {
          searchTokens: searchPredicate.term,
        });
      } else if (searchPredicate) {
        queryBuilder.where("search_text LIKE {searchPattern: String}", {
          searchPattern: searchPredicate.pattern,
        });
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

      if (slice.keyset) {
        const keyset = slice.keyset;
        queryBuilder.where(
          `(triggered_timestamp < {cursorTriggeredTimestamp: DateTime64(9)}
            OR (triggered_timestamp = {cursorTriggeredTimestamp: DateTime64(9)} AND trace_id < {cursorTraceId: String})
            OR (triggered_timestamp = {cursorTriggeredTimestamp: DateTime64(9)} AND trace_id = {cursorTraceId: String} AND span_id < {cursorSpanId: String})
            OR (triggered_timestamp = {cursorTriggeredTimestamp: DateTime64(9)} AND trace_id = {cursorTraceId: String} AND span_id = {cursorSpanId: String} AND projection_fingerprint < {cursorProjectionFingerprint: UInt128}))`,
          {
            cursorTriggeredTimestamp: keyset.triggeredTimestamp,
            cursorTraceId: keyset.traceId,
            cursorSpanId: keyset.spanId,
            cursorProjectionFingerprint: keyset.projectionFingerprint,
          }
        );
      }

      queryBuilder.orderBy(
        "triggered_timestamp DESC, trace_id DESC, span_id DESC, projection_fingerprint DESC"
      );
      queryBuilder.limit(queryLimit);

      return queryBuilder.executeWithStats({
        params: abortSignal ? { abort_signal: abortSignal } : undefined,
      });
    };

    const queryStartedAt = performance.now();
    const queryResponse = emptyRange || cursorExpired ? undefined : await runQuery();
    const queryElapsedMs = queryResponse ? performance.now() - queryStartedAt : 0;
    const [queryError, queryResult] = queryResponse ?? [null, null];
    let logs = queryResult?.rows ?? [];
    let nextSlice: LogsSearchSlice | undefined;
    let searchedTo: string | undefined;
    let timedOut = false;
    let stopped = false;

    if (cursorExpired) {
      logs = [];
    } else if (queryError) {
      if (!isClickhouseResourceLimitError(queryError)) {
        throw queryError;
      }
      if (!["TIMEOUT_EXCEEDED", "TOO_SLOW"].includes(queryError.clickhouseErrorType ?? "")) {
        throw new ServiceValidationError(
          searchPredicate === undefined
            ? "These logs exceeded a query resource limit. Try a shorter time range or add a filter."
            : "This search exceeded a query resource limit. Try a shorter time range, a more specific search, or add a filter."
        );
      }

      timedOut = true;
      logs = [];
      nextSlice = retryTimedOutLogsSearchSlice(slice);
      stopped = nextSlice === undefined;
    } else {
      const readRows = Number(queryResult?.stats.read_rows ?? 0);
      const elapsedMs = Number(queryResult?.stats.elapsed_ns ?? 0) / 1_000_000;
      const stats: LogsSearchSliceStats = {
        readRows: Number.isFinite(readRows) ? readRows : 0,
        elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : 0,
      };
      const page = prepareLogsSearchPage(logs, effectivePageSize, queryLimit);
      logs = page.rows;

      if (page.hasMore && logs.length > 0) {
        const lastLog = logs[logs.length - 1];
        nextSlice = continueLogsSearchSlice(slice, {
          triggeredTimestamp: lastLog.triggered_timestamp,
          traceId: lastLog.trace_id,
          spanId: lastLog.span_id,
          projectionFingerprint: lastLog.projection_fingerprint_string,
        });
        searchedTo = convertClickhouseDateTime64ToJsDate(lastLog.triggered_timestamp).toISOString();
      } else {
        nextSlice = nextLogsSearchSlice(slice, rangeFromMs, stats);
        searchedTo = new Date(slice.sliceFrom).toISOString();
      }
    }

    const nextCursor = nextSlice
      ? encodeLogsSearchCursor(organizationId, environmentId, filterFingerprint, nextSlice)
      : undefined;
    const searchComplete = nextCursor === undefined && !stopped && !cursorExpired;

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
        projectionFingerprint: log.projection_fingerprint_string,
        message: displayMessage,
        kind: log.kind,
        status: log.status,
        duration: typeof log.duration === "number" ? log.duration : Number(log.duration),
        level: kindToLevel(log.kind, log.status),
      };
    });

    const searchExpansion =
      searchComplete &&
      searchPredicate !== undefined &&
      time.isDefault &&
      transformedLogs.length === 0
        ? logsSearchExpansionPeriod(rangeFrom, rangeTo, retentionLimitDays)
        : undefined;

    return {
      logs: transformedLogs,
      pagination: {
        next: nextCursor,
        previous: undefined, // For now, only support forward pagination
      },
      pageSize: effectivePageSize,
      searchProgress: {
        searchedTo,
        complete: searchComplete,
        timedOut,
        stopped,
        expired: cursorExpired,
        queryElapsedMs,
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
        from: rangeFrom,
        to: rangeTo,
      },
      hasFilters,
      hasAnyLogs: transformedLogs.length > 0,
      searchTerm: search,
      searchExpansion: searchExpansion ? { nextPeriod: searchExpansion } : undefined,
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
