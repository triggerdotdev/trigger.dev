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

    const queryBuilder = this.clickhouse.taskEventsV2.logDetailQueryBuilder();

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


    let parsedAttributes: Record<string, unknown> = {};
    let rawAttributesString = "";


    try {
      // Handle attributes_text which is a string
      if (log.attributes_text) {
        parsedAttributes = JSON.parse(log.attributes_text) as Record<string, unknown>;
        rawAttributesString = log.attributes_text;
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
      attributes: parsedAttributes,
      // Raw strings for display
      rawAttributes: rawAttributesString,
    };
  }
}
