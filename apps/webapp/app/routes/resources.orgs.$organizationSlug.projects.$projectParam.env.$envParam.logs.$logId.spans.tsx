import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/node";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { clickhouseClient } from "~/services/clickhouseInstance.server";

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

// Fetch related spans for a log entry from the same trace
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam, logId } = {
    ...EnvironmentParamSchema.parse(params),
    logId: params.logId,
  };

  if (!logId) {
    throw new Response("Log ID is required", { status: 400 });
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Environment not found", { status: 404 });
  }

  // Get trace ID and run ID from query params
  const url = new URL(request.url);
  const traceId = url.searchParams.get("traceId");
  const runId = url.searchParams.get("runId");
  const currentSpanId = url.searchParams.get("spanId");

  if (!traceId || !runId) {
    throw new Response("Trace ID and Run ID are required", { status: 400 });
  }

  // Query ClickHouse for related spans in the same trace
  const queryBuilder = clickhouseClient.taskEventsV2.logsListQueryBuilder();

  queryBuilder.where("environment_id = {environmentId: String}", {
    environmentId: environment.id,
  });
  queryBuilder.where("trace_id = {traceId: String}", { traceId });
  queryBuilder.where("run_id = {runId: String}", { runId });

  // Order by start time to show spans in chronological order
  queryBuilder.orderBy("start_time ASC");
  queryBuilder.limit(50);

  const [queryError, records] = await queryBuilder.execute();

  if (queryError) {
    throw queryError;
  }

  const results = records || [];

  const spans = results.map((row) => ({
    id: `${row.trace_id}::${row.span_id}::${row.run_id}::${row.start_time}`,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id || null,
    message: row.message.substring(0, 200), // Truncate for list view
    kind: row.kind,
    level: kindToLevel(row.kind),
    status: row.status,
    startTime: new Date(Number(row.start_time) / 1_000_000).toISOString(),
    duration: Number(row.duration),
    isCurrent: row.span_id === currentSpanId,
  }));

  return json({ spans });
};
