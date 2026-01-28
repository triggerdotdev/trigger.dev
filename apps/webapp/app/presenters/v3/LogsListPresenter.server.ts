import { z } from "zod";
import { type ClickHouse } from "@internal/clickhouse";
import {
  type PrismaClientOrTransaction,
} from "@trigger.dev/database";
import { EVENT_STORE_TYPES, getConfiguredEventRepository } from "~/v3/eventRepository/index.server";

import parseDuration from "parse-duration";
import { type Direction } from "~/components/ListPagination";
import { timeFilters } from "~/components/runs/v3/SharedFilters";
import { findDisplayableEnvironment } from "~/models/runtimeEnvironment.server";
import { getAllTaskIdentifiers } from "~/models/task.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { kindToLevel, type LogLevel, LogLevelSchema } from "~/utils/logUtils";
import { BasePresenter } from "~/presenters/v3/basePresenter.server";
import {
  convertDateToClickhouseDateTime,
  convertClickhouseDateTime64ToJsDate,
} from "~/v3/eventRepository/clickhouseEventRepository.server";

export type { LogLevel };

type ErrorAttributes = {
  error?: {
    message?: unknown;
  };
  [key: string]: unknown;
};

function escapeClickHouseString(val: string): string {
  return val
    .replace(/\\/g, "\\\\")
    .replace(/\//g, "\\/")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}


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
  includeDebugLogs?: boolean;
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
  includeDebugLogs: z.boolean().optional(),
  direction: z.enum(["forward", "backward"]).optional(),
  cursor: z.string().optional(),
  pageSize: z.number().int().positive().max(1000).optional(),
});

const DEFAULT_PAGE_SIZE = 50;

export type LogsList = Awaited<ReturnType<LogsListPresenter["call"]>>;
export type LogEntry = LogsList["logs"][0];
export type LogsListAppliedFilters = LogsList["filters"];

// Cursor is a base64 encoded JSON of the pagination keys
type LogCursor = {
  environmentId: string;
  unixTimestamp: number;
  traceId: string;
};

const LogCursorSchema = z.object({
  environmentId: z.string(),
  unixTimestamp: z.number(),
  traceId: z.string(),
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
    case "DEBUG":
      return { kinds: ["DEBUG_EVENT", "LOG_DEBUG"] };
    case "INFO":
      return { kinds: ["LOG_INFO", "LOG_LOG"] };
    case "WARN":
      return { kinds: ["LOG_WARN"] };
    case "ERROR":
      return { kinds: ["LOG_ERROR"], statuses: ["ERROR"] };
  }
}

function convertDateToNanoseconds(date: Date): bigint {
  return BigInt(date.getTime()) * 1_000_000n;
}

function formatNanosecondsForClickhouse(ns: bigint): string {
  const nsString = ns.toString();
  // Handle negative numbers (dates before 1970-01-01)
  if (nsString.startsWith("-")) {
    const absString = nsString.slice(1);
    const padded = absString.padStart(19, "0");
    return "-" + padded.slice(0, 10) + "." + padded.slice(10);
  }
  // Pad positive numbers to 19 digits to ensure correct slicing
  const padded = nsString.padStart(19, "0");
  return padded.slice(0, 10) + "." + padded.slice(10);
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
      pageSize = DEFAULT_PAGE_SIZE,
      includeDebugLogs = true,
      defaultPeriod,
      retentionLimitDays,
    }: LogsListOptions
  ) {
    const time = timeFilters({
      period,
      from,
      to,
      defaultPeriod,
    });

    let effectiveFrom = time.from;
    let effectiveTo = time.to;

    if (!effectiveFrom && !effectiveTo && time.period) {
      const periodMs = parseDuration(time.period);
      if (periodMs) {
        effectiveFrom = new Date(Date.now() - periodMs);
        effectiveTo = new Date();
      }
    }

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

    const possibleTasksAsync = getAllTaskIdentifiers(this.replica, environmentId);

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

    const queryBuilder = this.clickhouse.taskEventsV2.logsListQueryBuilder();

    queryBuilder.where("environment_id = {environmentId: String}", {
      environmentId,
    });

    queryBuilder.where("organization_id = {organizationId: String}", {
      organizationId,
    });
    queryBuilder.where("project_id = {projectId: String}", { projectId });


    if (effectiveFrom) {
      const fromNs = convertDateToNanoseconds(effectiveFrom);

        queryBuilder.where("inserted_at >= {insertedAtStart: DateTime64(3)}", {
          insertedAtStart: convertDateToClickhouseDateTime(effectiveFrom),
        });

      queryBuilder.where("start_time >= {fromTime: String}", {
        fromTime: formatNanosecondsForClickhouse(fromNs),
      });
    }

    if (effectiveTo) {
      const clampedTo = effectiveTo > new Date() ? new Date() : effectiveTo;
      const toNs = convertDateToNanoseconds(clampedTo);

      queryBuilder.where("inserted_at <= {insertedAtEnd: DateTime64(3)}", {
        insertedAtEnd: convertDateToClickhouseDateTime(clampedTo),
      });

      queryBuilder.where("start_time <= {toTime: String}", {
        toTime: formatNanosecondsForClickhouse(toNs),
      });
    }

    // Task filter (applies directly to ClickHouse)
    if (tasks && tasks.length > 0) {
      queryBuilder.where("task_identifier IN {tasks: Array(String)}", {
        tasks,
      });
    }

    // Run ID filter
    if (runId && runId !== "") {
      queryBuilder.where("run_id = {runId: String}", { runId });
    }

    // Case-insensitive search in message, attributes, and status fields
    if (search && search.trim() !== "") {
      const searchTerm = escapeClickHouseString(search.trim()).toLowerCase();
      queryBuilder.where(
        "(lower(message) like {searchPattern: String} OR lower(attributes_text) like {searchPattern: String})",
        {
          searchPattern: `%${searchTerm}%`
        }
      );
    }

    if (levels && levels.length > 0) {
      const conditions: string[] = [];
      const params: Record<string, string[]> = {};

      for (const level of levels) {
        const filter = levelToKindsAndStatuses(level);
        const levelConditions: string[] = [];

        if (filter.kinds && filter.kinds.length > 0) {
          const kindsKey = `kinds_${level}`;
          let kindCondition = `kind IN {${kindsKey}: Array(String)}`;


          kindCondition += ` AND status NOT IN {excluded_statuses: Array(String)}`;
          params["excluded_statuses"] = ["ERROR", "CANCELLED"];


          levelConditions.push(kindCondition);
          params[kindsKey] = filter.kinds;
        }

        if (filter.statuses && filter.statuses.length > 0) {
          const statusesKey = `statuses_${level}`;
          levelConditions.push(`status IN {${statusesKey}: Array(String)}`);
          params[statusesKey] = filter.statuses;
        }

        if (levelConditions.length > 0) {
          conditions.push(`(${levelConditions.join(" OR ")})`);
        }
      }

      if (conditions.length > 0) {
        queryBuilder.where(`(${conditions.join(" OR ")})`, params);
      }
    }

    // Debug logs are available only to admins
    if (includeDebugLogs === false) {
      queryBuilder.where("kind NOT IN {debugKinds: Array(String)}", {
        debugKinds: ["DEBUG_EVENT"],
      });
    }

    queryBuilder.where("kind NOT IN {debugSpans: Array(String)}", {
      debugSpans: ["SPAN", "ANCESTOR_OVERRIDE", "SPAN_EVENT"],
    });

    // kindCondition += ` `;
    // params["excluded_statuses"] = ["SPAN", "ANCESTOR_OVERRIDE", "SPAN_EVENT"];


    queryBuilder.where("NOT (kind = 'SPAN' AND status = 'PARTIAL')");

    // Cursor pagination
    const decodedCursor = cursor ? decodeCursor(cursor) : null;
    if (decodedCursor) {
      queryBuilder.where(
        "(environment_id, toUnixTimestamp(start_time), trace_id) < ({cursorEnvId: String}, {cursorUnixTimestamp: Int64}, {cursorTraceId: String})",
        {
          cursorEnvId: decodedCursor.environmentId,
          cursorUnixTimestamp: decodedCursor.unixTimestamp,
          cursorTraceId: decodedCursor.traceId,
        }
      );
    }

    queryBuilder.orderBy("environment_id DESC, toUnixTimestamp(start_time) DESC, trace_id DESC");
    // Limit + 1 to check if there are more results
    queryBuilder.limit(pageSize + 1);

    const [queryError, records] = await queryBuilder.execute();

    if (queryError) {
      throw queryError;
    }

    const results = records || [];
    const hasMore = results.length > pageSize;
    const logs = results.slice(0, pageSize);

    // Build next cursor from the last item
    let nextCursor: string | undefined;
    if (hasMore && logs.length > 0) {
      const lastLog = logs[logs.length - 1];
      const unixTimestamp = Math.floor(new Date(lastLog.start_time).getTime() / 1000);
      nextCursor = encodeCursor({
        environmentId,
        unixTimestamp,
        traceId: lastLog.trace_id,
      });
    }

    // Transform results
    // Use :: as separator since dash conflicts with date format in start_time
    const transformedLogs = logs.map((log) => {
      let displayMessage = log.message;

      // For error logs with status ERROR, try to extract error message from attributes
      if (log.status === "ERROR" && log.attributes_text) {
        try {
          const attributes = JSON.parse(log.attributes_text) as ErrorAttributes;

          if (attributes?.error?.message && typeof attributes.error.message === "string") {
            displayMessage = attributes.error.message;
          }
        } catch {
          // If attributes parsing fails, use the regular message
        }
      }

      return {
        id: `${log.trace_id}::${log.span_id}::${log.run_id}::${log.start_time}`,
        runId: log.run_id,
        taskIdentifier: log.task_identifier,
        startTime: convertClickhouseDateTime64ToJsDate(log.start_time).toISOString(),
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
      possibleTasks: possibleTasks
        .map((task) => ({
          slug: task.slug,
          triggerSource: task.triggerSource,
        }))
        .sort((a, b) => a.slug.localeCompare(b.slug)),
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
      retention: retentionLimitDays !== undefined ? {
        limitDays: retentionLimitDays,
        wasClamped: wasClampedByRetention,
      } : undefined,
    };
  }
}
