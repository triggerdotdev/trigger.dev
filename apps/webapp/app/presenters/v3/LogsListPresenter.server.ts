import { type ClickHouse, type LogsListV2Result } from "@internal/clickhouse";
import { MachinePresetName } from "@trigger.dev/core/v3";
import {
  type PrismaClient,
  type PrismaClientOrTransaction,
  type TaskRunStatus,
  TaskTriggerSource,
} from "@trigger.dev/database";
import { type Direction } from "~/components/ListPagination";
import { timeFilters } from "~/components/runs/v3/SharedFilters";
import { findDisplayableEnvironment } from "~/models/runtimeEnvironment.server";
import { getAllTaskIdentifiers } from "~/models/task.server";
import { RunsRepository } from "~/services/runsRepository/runsRepository.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import {
  convertDateToClickhouseDateTime,
  convertClickhouseDateTime64ToJsDate,
} from "~/v3/eventRepository/clickhouseEventRepository.server";

export type LogsListOptions = {
  userId?: string;
  projectId: string;
  // filters
  tasks?: string[];
  versions?: string[];
  statuses?: TaskRunStatus[];
  tags?: string[];
  scheduleId?: string;
  period?: string;
  bulkId?: string;
  from?: number;
  to?: number;
  isTest?: boolean;
  rootOnly?: boolean;
  batchId?: string;
  runId?: string[];
  queues?: string[];
  machines?: MachinePresetName[];
  // search
  search?: string;
  // pagination
  direction?: Direction;
  cursor?: string;
  pageSize?: number;
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_RUN_IDS = 5000;

export type LogsList = Awaited<ReturnType<LogsListPresenter["call"]>>;
export type LogEntry = LogsList["logs"][0];
export type LogsListAppliedFilters = LogsList["filters"];

// Cursor is a base64 encoded JSON of the pagination keys
type LogCursor = {
  startTime: string;
  traceId: string;
  spanId: string;
  runId: string;
};

function encodeCursor(cursor: LogCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64");
}

function decodeCursor(cursor: string): LogCursor | null {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf-8");
    return JSON.parse(decoded) as LogCursor;
  } catch {
    return null;
  }
}

// Convert ClickHouse kind to display level
function kindToLevel(
  kind: string
): "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "LOG" {
  switch (kind) {
    case "DEBUG_EVENT":
    case "LOG_DEBUG":
      return "DEBUG";
    case "LOG_INFO":
      return "INFO";
    case "LOG_WARN":
      return "WARN";
    case "LOG_ERROR":
      return "ERROR";
    case "LOG_LOG":
      return "LOG";
    case "SPAN":
    case "ANCESTOR_OVERRIDE":
    case "SPAN_EVENT":
    default:
      return "TRACE";
  }
}

// Convert nanoseconds to milliseconds
function convertDateToNanoseconds(date: Date): bigint {
  return BigInt(date.getTime()) * 1_000_000n;
}

export class LogsListPresenter {
  constructor(
    private readonly replica: PrismaClientOrTransaction,
    private readonly clickhouse: ClickHouse
  ) {}

  public async call(
    organizationId: string,
    environmentId: string,
    {
      userId,
      projectId,
      tasks,
      versions,
      statuses,
      tags,
      scheduleId,
      period,
      bulkId,
      isTest,
      rootOnly,
      batchId,
      runId,
      queues,
      machines,
      search,
      from,
      to,
      direction = "forward",
      cursor,
      pageSize = DEFAULT_PAGE_SIZE,
    }: LogsListOptions
  ) {
    // Get time values from raw values (including default period)
    const time = timeFilters({
      period,
      from,
      to,
    });

    const hasStatusFilters = statuses && statuses.length > 0;
    const hasRunLevelFilters =
      (versions !== undefined && versions.length > 0) ||
      hasStatusFilters ||
      (bulkId !== undefined && bulkId !== "") ||
      (scheduleId !== undefined && scheduleId !== "") ||
      (tags !== undefined && tags.length > 0) ||
      batchId !== undefined ||
      (runId !== undefined && runId.length > 0) ||
      (queues !== undefined && queues.length > 0) ||
      (machines !== undefined && machines.length > 0) ||
      typeof isTest === "boolean" ||
      rootOnly === true;

    const hasFilters =
      (tasks !== undefined && tasks.length > 0) ||
      hasRunLevelFilters ||
      (search !== undefined && search !== "") ||
      !time.isDefault;

    // Get all possible tasks
    const possibleTasksAsync = getAllTaskIdentifiers(
      this.replica,
      environmentId
    );

    // Get possible bulk actions
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

    const [possibleTasks, bulkActions, displayableEnvironment] =
      await Promise.all([
        possibleTasksAsync,
        bulkActionsAsync,
        findDisplayableEnvironment(environmentId, userId),
      ]);

    // If the bulk action isn't in the most recent ones, add it separately
    if (
      bulkId &&
      !bulkActions.some((bulkAction) => bulkAction.friendlyId === bulkId)
    ) {
      const selectedBulkAction =
        await this.replica.bulkActionGroup.findFirst({
          select: {
            friendlyId: true,
            type: true,
            createdAt: true,
            name: true,
          },
          where: {
            friendlyId: bulkId,
            projectId,
            environmentId,
          },
        });

      if (selectedBulkAction) {
        bulkActions.push(selectedBulkAction);
      }
    }

    if (!displayableEnvironment) {
      throw new ServiceValidationError("No environment found");
    }

    // If we have run-level filters, we need to first get matching run IDs from Postgres
    let runIds: string[] | undefined;
    if (hasRunLevelFilters) {
      const runsRepository = new RunsRepository({
        clickhouse: this.clickhouse,
        prisma: this.replica as PrismaClient,
      });

      function clampToNow(date: Date): Date {
        const now = new Date();
        return date > now ? now : date;
      }

      runIds = await runsRepository.listFriendlyRunIds({
        organizationId,
        environmentId,
        projectId,
        tasks,
        versions,
        statuses,
        tags,
        scheduleId,
        period,
        from: time.from ? time.from.getTime() : undefined,
        to: time.to ? clampToNow(time.to).getTime() : undefined,
        isTest,
        rootOnly,
        batchId,
        runId,
        bulkId,
        queues,
        machines,
        page: {
          size: MAX_RUN_IDS,
          direction: "forward",
        },
      });

      // If no matching runs, return empty result
      if (runIds.length === 0) {
        return {
          logs: [],
          pagination: {
            next: undefined,
            previous: undefined,
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
            versions: versions || [],
            statuses: statuses || [],
            from: time.from,
            to: time.to,
          },
          hasFilters,
          hasAnyLogs: false,
          searchTerm: search,
        };
      }
    }

    // Build ClickHouse query
    const queryBuilder = this.clickhouse.taskEventsV2.logsListQueryBuilder();

    // Required filters
    queryBuilder.where("environment_id = {environmentId: String}", {
      environmentId,
    });
    queryBuilder.where("organization_id = {organizationId: String}", {
      organizationId,
    });
    queryBuilder.where("project_id = {projectId: String}", { projectId });

    // Time filter (with inserted_at for partition pruning)
    if (time.from) {
      const fromNs = convertDateToNanoseconds(time.from).toString();
      queryBuilder.where("inserted_at >= {insertedAtStart: DateTime64(3)}", {
        insertedAtStart: convertDateToClickhouseDateTime(time.from),
      });
      queryBuilder.where("start_time >= {fromTime: String}", {
        fromTime: fromNs.slice(0, 10) + "." + fromNs.slice(10),
      });
    }

    if (time.to) {
      const clampedTo = time.to > new Date() ? new Date() : time.to;
      const toNs = convertDateToNanoseconds(clampedTo).toString();
      // Add inserted_at filter for partition pruning
      queryBuilder.where("inserted_at <= {insertedAtEnd: DateTime64(3)}", {
        insertedAtEnd: convertDateToClickhouseDateTime(clampedTo),
      });
      queryBuilder.where("start_time <= {toTime: String}", {
        toTime: toNs.slice(0, 10) + "." + toNs.slice(10),
      });
    }

    // Task filter (applies directly to ClickHouse)
    if (tasks && tasks.length > 0) {
      queryBuilder.where("task_identifier IN {tasks: Array(String)}", {
        tasks,
      });
    }

    // Run IDs filter (from Postgres lookup)
    if (runIds && runIds.length > 0) {
      queryBuilder.where("run_id IN {runIds: Array(String)}", { runIds });
    }

    // Case-insensitive contains message search using ilike
    if (search && search.trim() !== "") {
      queryBuilder.where("message ilike {searchPattern: String}", {
        searchPattern: `%${search.trim()}%`,
      });
    }

    // Cursor pagination
    const decodedCursor = cursor ? decodeCursor(cursor) : null;
    if (decodedCursor) {
      queryBuilder.where(
        "(start_time, trace_id, span_id, run_id) < ({cursorStartTime: String}, {cursorTraceId: String}, {cursorSpanId: String}, {cursorRunId: String})",
        {
          cursorStartTime: decodedCursor.startTime,
          cursorTraceId: decodedCursor.traceId,
          cursorSpanId: decodedCursor.spanId,
          cursorRunId: decodedCursor.runId,
        }
      );
    }

    // Order by newest first
    queryBuilder.orderBy("start_time DESC, trace_id DESC, span_id DESC, run_id DESC");

    // Limit + 1 to check if there are more results
    queryBuilder.limit(pageSize + 1);

    // Execute query
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
      nextCursor = encodeCursor({
        startTime: lastLog.start_time,
        traceId: lastLog.trace_id,
        spanId: lastLog.span_id,
        runId: lastLog.run_id,
      });
    }

    // Transform results
    // Use :: as separator since dash conflicts with date format in start_time
    const transformedLogs = logs.map((log) => ({
      id: `${log.trace_id}::${log.span_id}::${log.run_id}::${log.start_time}`,
      runId: log.run_id,
      taskIdentifier: log.task_identifier,
      startTime: convertClickhouseDateTime64ToJsDate(log.start_time).toISOString(),
      traceId: log.trace_id,
      spanId: log.span_id,
      parentSpanId: log.parent_span_id || null,
      message: log.message,
      kind: log.kind,
      status: log.status,
      duration: typeof log.duration === "number" ? log.duration : Number(log.duration),
      level: kindToLevel(log.kind),
    }));

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
        versions: versions || [],
        statuses: statuses || [],
        from: time.from,
        to: time.to,
      },
      hasFilters,
      hasAnyLogs: transformedLogs.length > 0,
      searchTerm: search,
    };
  }
}
