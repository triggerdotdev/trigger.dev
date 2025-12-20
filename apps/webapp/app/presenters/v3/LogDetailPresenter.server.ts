import { type ClickHouse } from "@internal/clickhouse";
import { type PrismaClientOrTransaction } from "@trigger.dev/database";
import {
  convertClickhouseDateTime64ToJsDate,
  convertDateToClickhouseDateTime,
} from "~/v3/eventRepository/clickhouseEventRepository.server";

export type LogDetailOptions = {
  environmentId: string;
  organizationId: string;
  projectId: string;
  spanId: string;
  traceId: string;
  // Time bounds for query optimization
  startTime?: Date;
};

export type LogDetail = Awaited<ReturnType<LogDetailPresenter["call"]>>;

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

export class LogDetailPresenter {
  constructor(
    private readonly replica: PrismaClientOrTransaction,
    private readonly clickhouse: ClickHouse
  ) {}

  public async call(options: LogDetailOptions) {
    const { environmentId, organizationId, projectId, spanId, traceId, startTime } = options;

    // Build ClickHouse query
    const queryBuilder = this.clickhouse.taskEventsV2.logDetailQueryBuilder();

    // Required filters
    queryBuilder.where("environment_id = {environmentId: String}", {
      environmentId,
    });
    queryBuilder.where("organization_id = {organizationId: String}", {
      organizationId,
    });
    queryBuilder.where("project_id = {projectId: String}", { projectId });
    queryBuilder.where("span_id = {spanId: String}", { spanId });
    queryBuilder.where("trace_id = {traceId: String}", { traceId });

    // Add time bounds for partition pruning if available
    if (startTime) {
      const startTimeWithBuffer = new Date(startTime.getTime() - 60_000); // 1 minute buffer
      queryBuilder.where("inserted_at >= {insertedAtStart: DateTime64(3)}", {
        insertedAtStart: convertDateToClickhouseDateTime(startTimeWithBuffer),
      });
    }

    queryBuilder.limit(1);

    // Execute query
    const [queryError, records] = await queryBuilder.execute();

    if (queryError) {
      throw queryError;
    }

    if (!records || records.length === 0) {
      return null;
    }

    const log = records[0];

    // Parse metadata and attributes
    let parsedMetadata: Record<string, unknown> = {};
    let parsedAttributes: Record<string, unknown> = {};

    try {
      if (log.metadata) {
        parsedMetadata = JSON.parse(log.metadata) as Record<string, unknown>;
      }
    } catch {
      // Ignore parse errors
    }

    try {
      if (log.attributes_text) {
        parsedAttributes = JSON.parse(log.attributes_text) as Record<string, unknown>;
      }
    } catch {
      // Ignore parse errors
    }

    return {
      // Use :: separator to match LogsListPresenter format
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
      metadata: parsedMetadata,
      attributes: parsedAttributes,
      // Raw strings for display
      rawMetadata: log.metadata,
      rawAttributes: log.attributes_text,
    };
  }
}
