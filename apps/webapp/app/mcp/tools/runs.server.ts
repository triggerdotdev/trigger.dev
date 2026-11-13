import type {
  RetrieveRunTraceResponseBody,
  RetrieveSpanDetailResponseBody,
} from "@trigger.dev/core/v3";
import { setTimeout as sleep } from "node:timers/promises";
import { CURRENT_API_VERSION } from "~/api/versions";
import { extractAISpanData } from "~/components/runs/v3/ai";
import { $replica } from "~/db.server";
import {
  ApiRunListPresenter,
  ApiRunListSearchParams,
} from "~/presenters/v3/ApiRunListPresenter.server";
import { ApiRetrieveRunPresenter } from "~/presenters/v3/ApiRetrieveRunPresenter.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { RunsListQueryError } from "~/services/runsRepository/runsRepository.server";
import { getEventRepositoryForStore } from "~/v3/eventRepository/index.server";
import { getTraceAncestorInsertedAtStart } from "~/v3/eventRepository/traceAncestorBound.server";
import {
  getTraceInsertedAtEnd,
  getTraceStartTimeEnd,
} from "~/v3/eventRepository/traceInsertedAtBound";
import { findRunByIdWithMollifierFallback } from "~/v3/mollifier/readFallback.server";
import {
  buildSyntheticSpanDetailBody,
  buildSyntheticTraceBody,
} from "~/v3/mollifier/syntheticApiResponses.server";
import { runStore } from "~/v3/runStore.server";
import { getTaskEventStoreTableForRun } from "~/v3/taskEventStore.server";
import { fenceUntrusted } from "../gate/fence.server";
import type { McpToolDefinition } from "../registry.server";
import {
  dashboardUrl,
  defineReadTool,
  errorResult,
  resolveToolEnvironment,
  textResult,
} from "./define.server";
import {
  formatRun,
  formatRunList,
  formatRunShape,
  formatRunTrace,
  formatSpanDetail,
} from "./format/runs";
import {
  GetRunDetailsInput,
  GetSpanDetailsInput,
  ListRunsInput,
  WaitForRunInput,
} from "./schemas/runs";

const MAX_WAIT_MS = 60_000;
const INITIAL_POLL_MS = 500;
const MAX_POLL_MS = 5_000;
const MAX_TRACE_PAGE_LINES = 2_000;

type ListRuns = (
  environment: AuthenticatedEnvironment,
  searchParams: ApiRunListSearchParams
) => Promise<unknown>;

type ApiRunListSearchParams = ReturnType<typeof ApiRunListSearchParams.parse>;

export type RunsToolsOptions = {
  listRuns?: ListRuns;
  maxWaitMs?: number;
  initialPollMs?: number;
};

const defaultListRuns: ListRuns = (environment, searchParams) =>
  new ApiRunListPresenter().call(
    environment.project,
    searchParams,
    CURRENT_API_VERSION,
    environment
  );

const encodeTraceCursor = (runId: string, offset: number) =>
  Buffer.from(JSON.stringify({ r: runId, o: offset })).toString("base64url");

function decodeTraceCursor(cursor: string, runId: string): number | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      r?: unknown;
      o?: unknown;
    };
    const offset = parsed.o;
    return parsed.r === runId &&
      typeof offset === "number" &&
      Number.isInteger(offset) &&
      offset >= 0
      ? offset
      : null;
  } catch {
    return null;
  }
}

async function findTraceRun(runId: string, environment: AuthenticatedEnvironment) {
  const pgRun = await runStore.findRun(
    { friendlyId: runId, runtimeEnvironmentId: environment.id },
    $replica
  );
  if (pgRun) return { source: "pg" as const, run: pgRun };

  const buffered = await findRunByIdWithMollifierFallback({
    runId,
    environmentId: environment.id,
    organizationId: environment.organizationId,
  });
  return buffered ? { source: "buffer" as const, run: buffered } : null;
}

async function loadTrace(runId: string, environment: AuthenticatedEnvironment) {
  const resolved = await findTraceRun(runId, environment);
  if (!resolved) return null;
  if (resolved.source === "buffer") {
    return buildSyntheticTraceBody(resolved.run).trace as RetrieveRunTraceResponseBody["trace"];
  }

  const run = resolved.run;
  const eventRepository = await getEventRepositoryForStore(
    run.taskEventStore,
    environment.organization.id
  );
  const summary = await eventRepository.getTraceDetailedSubtreeSummary(
    getTaskEventStoreTableForRun(run),
    environment.id,
    run.traceId,
    run.spanId,
    run.createdAt,
    getTraceStartTimeEnd(run),
    {
      insertedAtEnd: getTraceInsertedAtEnd(run),
      ancestorInsertedAtStart: await getTraceAncestorInsertedAtStart(run, runStore, $replica),
    }
  );
  return (summary as RetrieveRunTraceResponseBody["trace"] | undefined) ?? null;
}

async function loadSpan(
  runId: string,
  spanId: string,
  environment: AuthenticatedEnvironment
): Promise<RetrieveSpanDetailResponseBody | null> {
  const resolved = await findTraceRun(runId, environment);
  if (!resolved) return null;

  if (resolved.source === "buffer") {
    if (resolved.run.spanId !== spanId) return null;
    return buildSyntheticSpanDetailBody(resolved.run) as RetrieveSpanDetailResponseBody;
  }

  const run = resolved.run;
  const eventRepository = await getEventRepositoryForStore(
    run.taskEventStore,
    environment.organization.id
  );
  const span = await eventRepository.getSpan(
    getTaskEventStoreTableForRun(run),
    environment.id,
    spanId,
    run.traceId,
    run.createdAt,
    getTraceStartTimeEnd(run),
    { insertedAtEnd: getTraceInsertedAtEnd(run) }
  );
  if (!span) return null;

  const durationMs = span.duration / 1_000_000;
  const aiData =
    span.properties && typeof span.properties === "object"
      ? extractAISpanData(span.properties as Record<string, unknown>, durationMs)
      : undefined;

  const triggeredRuns = await runStore.findRuns(
    {
      take: 50,
      select: { friendlyId: true, taskIdentifier: true, status: true },
      where: { runtimeEnvironmentId: environment.id, parentSpanId: spanId },
    },
    $replica
  );

  const properties =
    span.properties &&
    typeof span.properties === "object" &&
    Object.keys(span.properties as Record<string, unknown>).length > 0
      ? (span.properties as Record<string, unknown>)
      : undefined;

  return {
    spanId: span.spanId,
    parentId: span.parentId,
    runId: run.friendlyId,
    message: span.message,
    isError: span.isError,
    isPartial: span.isPartial,
    isCancelled: span.isCancelled,
    level: span.level,
    startTime: span.startTime,
    durationMs,
    properties,
    events: span.events?.length ? span.events : undefined,
    entityType: span.entity.type ?? undefined,
    ai: aiData,
    triggeredRuns:
      triggeredRuns.length > 0
        ? triggeredRuns.map((r) => ({
            runId: r.friendlyId,
            taskIdentifier: r.taskIdentifier,
            status: r.status,
          }))
        : undefined,
  } as unknown as RetrieveSpanDetailResponseBody;
}

export function createRunsTools(options: RunsToolsOptions = {}): McpToolDefinition[] {
  const listRunsFn = options.listRuns ?? defaultListRuns;
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
  const initialPollMs = options.initialPollMs ?? INITIAL_POLL_MS;

  const listRuns = defineReadTool({
    name: "list_runs",
    title: "List Runs",
    description:
      "List all runs for a project. Use this tool when you need to search for a run or list all runs for a project.",
    shape: ListRunsInput.shape,
    auth: { action: "read", subject: "runs" },
    run: async (input, ctx) => {
      const environment = await resolveToolEnvironment(ctx);
      if (!environment) return errorResult("Environment not found");

      const parsedParams = ApiRunListSearchParams.safeParse(
        Object.fromEntries(
          Object.entries({
            "page[size]": input.limit,
            "page[after]": input.cursor,
            "filter[status]": input.status,
            "filter[taskIdentifier]": input.taskIdentifier,
            "filter[version]": input.version,
            "filter[tag]": input.tag,
            "filter[createdAt][from]": input.from,
            "filter[createdAt][to]": input.to,
            "filter[createdAt][period]": input.period,
            "filter[machine]": input.machine,
            "filter[region]": input.region,
          }).filter(([, value]) => value !== undefined)
        )
      );

      if (!parsedParams.success) {
        return errorResult(parsedParams.error.issues.map((issue) => issue.message).join("; "));
      }

      try {
        const result = await listRunsFn(environment, parsedParams.data);
        return textResult(formatRunList(result as Parameters<typeof formatRunList>[0]));
      } catch (error) {
        if (error instanceof RunsListQueryError || error instanceof ServiceValidationError) {
          return errorResult(error.message);
        }
        throw error;
      }
    },
  });

  const getRunDetails = defineReadTool({
    name: "get_run_details",
    title: "Get Run Details",
    description:
      "Get the details and trace of a run. Trace events are paginated — the first call returns run details and the first page of trace lines. Pass the returned cursor to fetch subsequent pages without re-fetching the trace. The run ID starts with run_.",
    shape: GetRunDetailsInput.shape,
    auth: { action: "read", subject: "runs" },
    run: async (input, ctx) => {
      const environment = await resolveToolEnvironment(ctx);
      if (!environment) return errorResult("Environment not found");

      const offset = input.cursor ? decodeTraceCursor(input.cursor, input.runId) : 0;
      if (offset === null) return errorResult("Invalid cursor");

      const found = await ApiRetrieveRunPresenter.findRun(input.runId, environment);
      if (!found) return errorResult("Run not found");

      const trace = await loadTrace(input.runId, environment);
      if (!trace && offset > 0) return errorResult("Trace not found");

      const allLines = trace ? formatRunTrace(trace).split("\n") : [];
      const end = offset + Math.min(Math.max(input.maxTraceLines, 1), MAX_TRACE_PAGE_LINES);
      const pageLines = allLines.slice(offset, end);

      const content: string[] = [];

      if (offset === 0) {
        const run = await new ApiRetrieveRunPresenter(CURRENT_API_VERSION).call(found, environment);
        content.push("## Run Details");
        content.push(formatRun(run as Parameters<typeof formatRun>[0]));
        content.push("");
      }

      if (trace) {
        content.push(
          `## Run Trace (lines ${offset + 1}-${offset + pageLines.length} of ${allLines.length})`
        );
        content.push(fenceUntrusted(pageLines.join("\n"), "run-trace"));
      } else {
        content.push("## Run Trace");
        content.push("Trace not available yet.");
      }

      if (end < allLines.length) {
        content.push("");
        content.push(
          `**More trace available.** Call \`get_run_details\` again with \`cursor: "${encodeTraceCursor(input.runId, end)}"\` and \`runId: "${input.runId}"\` to see the next page.`
        );
      }

      if (offset === 0) {
        content.push("");
        content.push(
          `[View in dashboard](${dashboardUrl(`/projects/v3/${environment.project.externalRef}/runs/${found.friendlyId}`)})`
        );
      }

      return textResult(content.join("\n"));
    },
  });

  const getSpanDetails = defineReadTool({
    name: "get_span_details",
    title: "Get Span Details",
    description:
      "Get detailed information about a specific span within a run trace. Use get_run_details first to see the trace and find span IDs (shown as [spanId] in the trace output). Returns timing, properties/attributes, error info, and for AI spans: model, tokens, cost, and response data.",
    shape: GetSpanDetailsInput.shape,
    auth: { action: "read", subject: "runs" },
    run: async (input, ctx) => {
      const environment = await resolveToolEnvironment(ctx);
      if (!environment) return errorResult("Environment not found");

      const span = await loadSpan(input.runId, input.spanId, environment);
      if (!span) return errorResult("Span not found");

      return textResult(
        [
          formatSpanDetail(span),
          "",
          `[View run in dashboard](${dashboardUrl(`/projects/v3/${environment.project.externalRef}/runs/${input.runId}`)})`,
        ].join("\n")
      );
    },
  });

  const waitForRun = defineReadTool({
    name: "wait_for_run_to_complete",
    title: "Wait for Run to Complete",
    description:
      "Wait for a run to complete. The run ID is the ID of the run that was triggered. It starts with run_. Has an optional timeoutInSeconds parameter (default 60s) - if the run doesn't complete within that time, the current state of the run will be returned.",
    shape: WaitForRunInput.shape,
    auth: { action: "read", subject: "runs" },
    run: async (input, ctx) => {
      const environment = await resolveToolEnvironment(ctx);
      if (!environment) return errorResult("Environment not found");

      const boundMs = Math.min(Math.max(input.timeoutInSeconds, 0) * 1000, maxWaitMs);
      const deadline = Date.now() + boundMs;
      const signal = getRequestAbortSignal();
      let delay = initialPollMs;
      let completed = false;
      let found = await ApiRetrieveRunPresenter.findRun(input.runId, environment);

      while (found) {
        const status = ApiRetrieveRunPresenter.apiStatusFromRunStatus(
          found.status,
          CURRENT_API_VERSION
        );
        completed = ApiRetrieveRunPresenter.apiBooleanHelpersFromRunStatus(status).isCompleted;

        const remaining = deadline - Date.now();
        if (completed || remaining <= 0 || signal.aborted) break;

        await sleep(Math.min(delay, remaining), undefined, { signal }).catch(() => undefined);
        if (signal.aborted) break;
        delay = Math.min(delay * 2, MAX_POLL_MS);
        found = await ApiRetrieveRunPresenter.findRun(input.runId, environment);
      }

      if (!found) return errorResult("Run not found");

      const run = await new ApiRetrieveRunPresenter(CURRENT_API_VERSION).call(found, environment);
      const prefix = completed
        ? ""
        : `Run still running after ${Math.round(boundMs / 1000)}s. Call wait_for_run_to_complete again to keep waiting. Current run state:\n\n`;

      return textResult(prefix + formatRunShape(run as Parameters<typeof formatRunShape>[0]));
    },
  });

  return [listRuns, getRunDetails, getSpanDetails, waitForRun];
}

export const runsTools = createRunsTools();
