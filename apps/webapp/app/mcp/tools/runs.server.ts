import type {
  RetrieveRunTraceResponseBody,
  RetrieveSpanDetailResponseBody,
} from "@trigger.dev/core/v3";
import { setTimeout as sleep } from "node:timers/promises";
import parseDuration from "parse-duration";
import { CURRENT_API_VERSION } from "~/api/versions";
import { extractAISpanData } from "~/components/runs/v3/ai";
import { $replica } from "~/db.server";
import {
  ApiRunListPresenter,
  ApiRunListSearchParams,
} from "~/presenters/v3/ApiRunListPresenter.server";
import { ApiRetrieveRunPresenter } from "~/presenters/v3/ApiRetrieveRunPresenter.server";
import { RunTagListPresenter } from "~/presenters/v3/RunTagListPresenter.server";
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
import { dashboardUrl, defineReadTool, resolveToolEnvironment, textResult } from "./define.server";
import {
  formatRun,
  formatRunList,
  formatRunShape,
  formatRunTrace,
  formatSpanDetail,
  invalidTraceCursor,
  runNotFound,
  spanNotFound,
  traceNotFound,
} from "./format/runs";
import { plainError } from "./format/insights";
import { untrusted } from "./format/logFields";
import { friendlyIdPattern } from "./schemas/bulkActions";
import {
  GetRunDetailsInput,
  GetSpanDetailsInput,
  ListRunsInput,
  ListRunTagsInput,
  WaitForRunInput,
} from "./schemas/runs";

const MAX_WAIT_MS = 60_000;
const INITIAL_POLL_MS = 500;
const MAX_POLL_MS = 5_000;
const MAX_TRACE_PAGE_LINES = 2_000;
const MESSAGE_CHARS = 300;

const LIST_RUNS_QUERY_KEYS = {
  limit: "page[size]",
  cursor: "page[after]",
  before: "page[before]",
  status: "filter[status]",
  taskIdentifier: "filter[taskIdentifier]",
  version: "filter[version]",
  tag: "filter[tag]",
  from: "filter[createdAt][from]",
  to: "filter[createdAt][to]",
  period: "filter[createdAt][period]",
  machine: "filter[machine]",
  region: "filter[region]",
  queue: "filter[queue]",
  batch: "filter[batch]",
  schedule: "filter[schedule]",
  bulkAction: "filter[bulkAction]",
} as const;

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
      if (!environment) return plainError("Environment not found");
      if (input.cursor !== undefined && input.before !== undefined) {
        return plainError("Invalid arguments: pass cursor or before, not both");
      }

      const parsedParams = ApiRunListSearchParams.safeParse(
        Object.fromEntries(
          Object.entries(LIST_RUNS_QUERY_KEYS)
            .map(([arg, key]) => [key, input[arg as keyof typeof LIST_RUNS_QUERY_KEYS]])
            .filter(([, value]) => value !== undefined)
        )
      );

      if (!parsedParams.success) {
        const argOf = new Map<string, string>(
          Object.entries(LIST_RUNS_QUERY_KEYS).map(([arg, key]) => [key, arg])
        );
        const fields = new Set(
          parsedParams.error.issues.map(
            (issue) => argOf.get(String(issue.path[0])) ?? "an argument"
          )
        );
        const details = parsedParams.error.issues.map((issue) => issue.message).join("; ");
        return plainError(
          `Invalid arguments: ${[...fields].join(", ")}. Check each value against the tool's input schema. Details: ${untrusted(details, "run-list-error", MESSAGE_CHARS)}`
        );
      }

      for (const [name, prefix] of [
        ["batch", "batch"],
        ["schedule", "sched"],
        ["bulkAction", "bulk"],
      ] as const) {
        const value = input[name];
        if (value !== undefined && !friendlyIdPattern(prefix).test(value)) {
          return plainError(
            `Invalid arguments: ${name} must be lowercase ${prefix}_ followed by letters and digits`
          );
        }
      }

      try {
        const page = (await listRunsFn(environment, parsedParams.data)) as Parameters<
          typeof formatRunList
        >[0];
        // A previous page comes back oldest first; show it newest first like every other page.
        return textResult(
          formatRunList(input.before ? { ...page, data: [...page.data].reverse() } : page)
        );
      } catch (error) {
        if (error instanceof RunsListQueryError) return plainError(error.message);
        if (error instanceof ServiceValidationError) {
          return plainError(
            `The runs could not be listed: ${untrusted(error.message, "run-list-error", MESSAGE_CHARS)}`
          );
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
      if (!environment) return plainError("Environment not found");

      const offset = input.cursor ? decodeTraceCursor(input.cursor, input.runId) : 0;
      if (offset === null) return plainError(invalidTraceCursor(input.runId));

      const found = await ApiRetrieveRunPresenter.findRun(input.runId, environment);
      if (!found) return plainError(runNotFound(input.runId));

      const trace = await loadTrace(input.runId, environment);
      if (!trace && offset > 0) return plainError(traceNotFound(input.runId));

      const allLines = trace ? formatRunTrace(trace).split("\n") : [];
      const end = offset + Math.min(Math.max(input.maxTraceLines, 1), MAX_TRACE_PAGE_LINES);
      const pageLines = allLines.slice(offset, end);

      const content: string[] = [];

      if (offset === 0) {
        const run = await new ApiRetrieveRunPresenter(CURRENT_API_VERSION).call(found, environment);
        content.push("## Run Details");
        content.push(formatRun(run as Parameters<typeof formatRun>[0], found));
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
      if (!environment) return plainError("Environment not found");

      const span = await loadSpan(input.runId, input.spanId, environment);
      if (!span) return plainError(spanNotFound(input.spanId, input.runId));

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
      if (!environment) return plainError("Environment not found");

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

      if (!found) return plainError(runNotFound(input.runId));

      const run = await new ApiRetrieveRunPresenter(CURRENT_API_VERSION).call(found, environment);
      const prefix = completed
        ? ""
        : `Run still running after ${Math.round(boundMs / 1000)}s. Call wait_for_run_to_complete again to keep waiting. Current run state:\n\n`;

      return textResult(prefix + formatRunShape(run as Parameters<typeof formatRunShape>[0]));
    },
  });

  const listRunTags = defineReadTool({
    name: "list_run_tags",
    title: "List Run Tags",
    description:
      "List the tags used on runs in an environment, in alphabetical order. Only tags on runs created in the period are included. Use a returned tag with the `tag` filter of list_runs.",
    shape: ListRunTagsInput.shape,
    auth: { action: "read", subject: "runs" },
    run: async (input, ctx) => {
      const environment = await resolveToolEnvironment(ctx);
      if (!environment) return plainError("Environment not found");

      if (!parseDuration(input.period, "ms")) {
        return plainError("Invalid arguments: period must be a duration such as 7d, 12h or 30m");
      }

      try {
        const result = await new RunTagListPresenter().call({
          organizationId: environment.organizationId,
          projectId: environment.projectId,
          environmentId: environment.id,
          name: input.name,
          period: input.period,
          pageSize: input.limit,
        });
        const tags = result.tags.slice(0, input.limit);

        if (tags.length === 0) return textResult(`No tags found in the last ${input.period}.`);

        const lines = [
          `Found ${tags.length} tag${tags.length === 1 ? "" : "s"} in the last ${input.period}:`,
          fenceUntrusted(tags.join("\n"), "run-tags"),
        ];
        if (result.hasMore) {
          lines.push("More tags match. Pass `name` to narrow the list or raise `limit`.");
        }
        return textResult(lines.join("\n"));
      } catch (error) {
        if (error instanceof RunsListQueryError) return plainError(error.message);
        throw error;
      }
    },
  });

  return [listRuns, getRunDetails, getSpanDetails, waitForRun, listRunTags];
}

export const runsTools = createRunsTools();
