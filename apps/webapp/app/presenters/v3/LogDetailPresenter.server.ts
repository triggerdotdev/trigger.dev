import { type ClickHouse } from "@internal/clickhouse";
import { type PrismaClientOrTransaction } from "@trigger.dev/database";
import { convertClickhouseDateTime64ToJsDate } from "~/v3/eventRepository/clickhouseEventRepository.server";
import { kindToLevel } from "~/utils/logUtils";
import { getConfiguredEventRepository } from "~/v3/eventRepository/index.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";

export type LogDetailOptions = {
  environmentId: string;
  organizationId: string;
  projectId: string;
  spanId: string;
  traceId: string;
  // The exact start_time from the log id - used to uniquely identify the event
  startTime: string;
};

export type LogDetail = Awaited<ReturnType<LogDetailPresenter["call"]>>;

export class LogDetailPresenter {
  constructor(
    private readonly replica: PrismaClientOrTransaction,
    private readonly clickhouse: ClickHouse
  ) {}

  public async call(options: LogDetailOptions) {
    const { environmentId, organizationId, projectId, spanId, traceId, startTime } = options;

    // Determine which store to use based on organization configuration
    const { store } = await getConfiguredEventRepository(organizationId);

    // Throw error if postgres is detected
    if (store === "postgres") {
      throw new ServiceValidationError(
        "Log details are not available for PostgreSQL event store. Please contact support."
      );
    }

    // Throw error if clickhouse v1 is detected (not supported)
    if (store === "postgres") {
      throw new ServiceValidationError(
        "Log details are not available for postgres event store. Please contact support."
      );
    }

    // Build ClickHouse query - only v2 is supported for log details
    const isClickhouseV2 = store === "clickhouse_v2";
    const queryBuilder = isClickhouseV2
      ? this.clickhouse.taskEventsV2.logDetailQueryBuilder()
      : this.clickhouse.taskEvents.logDetailQueryBuilder();

    // Required filters - spanId, traceId, and startTime uniquely identify the log
    // Multiple events can share the same spanId (span, span events, logs), so startTime is needed
    queryBuilder.where("environment_id = {environmentId: String}", {
      environmentId,
    });
    queryBuilder.where("organization_id = {organizationId: String}", {
      organizationId,
    });
    queryBuilder.where("project_id = {projectId: String}", { projectId });
    queryBuilder.where("span_id = {spanId: String}", { spanId });
    queryBuilder.where("trace_id = {traceId: String}", { traceId });
    queryBuilder.where("start_time = {startTime: String}", { startTime });

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
    let rawAttributesString = "";

    try {
      if (log.metadata) {
        parsedMetadata = JSON.parse(log.metadata) as Record<string, unknown>;
      }
    } catch {
      // Ignore parse errors
    }

    try {
      // Handle attributes which could be a JSON object or string
      if (log.attributes) {
        if (typeof log.attributes === "string") {
          parsedAttributes = JSON.parse(log.attributes) as Record<string, unknown>;
          rawAttributesString = log.attributes;
        } else if (typeof log.attributes === "object") {
          parsedAttributes = log.attributes as Record<string, unknown>;
          rawAttributesString = JSON.stringify(log.attributes);
        }
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
      level: kindToLevel(log.kind, log.status),
      metadata: parsedMetadata,
      attributes: parsedAttributes,
      // Raw strings for display
      rawMetadata: log.metadata,
      rawAttributes: rawAttributesString,
    };
  }
}
