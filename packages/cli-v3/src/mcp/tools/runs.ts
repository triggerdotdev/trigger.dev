import { AnyRunShape } from "@trigger.dev/core/v3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toolsMetadata } from "../config.js";
import { formatRun, formatRunList, formatRunShape, formatRunTrace, formatSpanDetail } from "../formatters.js";
import { CommonRunsInput, GetRunDetailsInput, GetSpanDetailsInput, ListRunsInput, WaitForRunInput } from "../schemas.js";
import { respondWithError, toolHandler } from "../utils.js";

// Cache formatted traces in temp files keyed by runId.
// Each entry stores the file path and total line count.
const traceCache = new Map<string, { filePath: string; totalLines: number; expiresAt: number }>();
const TRACE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getTraceCacheDir(): string {
  const dir = path.join(os.tmpdir(), "trigger-mcp-traces");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Read a page of lines from a file. Returns the lines and whether there are more. */
function readLinesPage(
  filePath: string,
  offset: number,
  limit: number,
  totalLines: number
): { lines: string[]; hasMore: boolean; nextCursor: string | null } {
  const content = fs.readFileSync(filePath, "utf-8");
  const allLines = content.split("\n");
  const pageLines = allLines.slice(offset, offset + limit);
  const end = offset + limit;
  const hasMore = end < totalLines;

  return {
    lines: pageLines,
    hasMore,
    nextCursor: hasMore ? String(end) : null,
  };
}

export const getRunDetailsTool = {
  name: toolsMetadata.get_run_details.name,
  title: toolsMetadata.get_run_details.title,
  description: toolsMetadata.get_run_details.description,
  inputSchema: GetRunDetailsInput.shape,
  handler: toolHandler(GetRunDetailsInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling get_run_details", { input });

    if (ctx.options.devOnly && input.environment !== "dev") {
      return respondWithError(
        `This MCP server is only available for the dev environment. You tried to access the ${input.environment} environment. Remove the --dev-only flag to access other environments.`
      );
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: [`read:runs:${input.runId}`],
      branch: input.branch,
    });

    const limit = input.maxTraceLines;
    const offset = input.cursor ? parseInt(input.cursor, 10) : 0;

    // Check if we have a cached trace file for this run
    let cached = traceCache.get(input.runId);
    if (cached && Date.now() >= cached.expiresAt) {
      // Expired — clean up
      try {
        fs.unlinkSync(cached.filePath);
      } catch {}
      traceCache.delete(input.runId);
      cached = undefined;
    }

    let formattedRun: string | undefined;
    let runUrl: string | undefined;

    if (!cached) {
      // Fetch and cache the full trace
      const [runResult, traceResult] = await Promise.all([
        apiClient.retrieveRun(input.runId),
        apiClient.retrieveRunTrace(input.runId),
      ]);

      formattedRun = formatRun(runResult);
      runUrl = await ctx.getDashboardUrl(`/projects/v3/${projectRef}/runs/${runResult.id}`);

      // Format the full trace (no line limit — we're writing to a file)
      const fullTrace = formatRunTrace(traceResult.trace, Infinity);
      const traceLines = fullTrace.split("\n");

      // Write to temp file
      const filePath = path.join(getTraceCacheDir(), `${input.runId}.txt`);
      fs.writeFileSync(filePath, fullTrace, "utf-8");

      // Only cache runs in terminal states — active runs need fresh traces
      const terminalStatuses = new Set([
        "COMPLETED",
        "CANCELED",
        "FAILED",
        "CRASHED",
        "SYSTEM_FAILURE",
        "EXPIRED",
        "TIMED_OUT",
      ]);

      cached = {
        filePath,
        totalLines: traceLines.length,
        expiresAt: Date.now() + TRACE_CACHE_TTL_MS,
      };

      if (terminalStatuses.has(runResult.status)) {
        traceCache.set(input.runId, cached);
      }
    }

    // Read the requested page
    const page = readLinesPage(cached.filePath, offset, limit, cached.totalLines);

    const content: string[] = [];

    // Only include run details on the first page
    if (offset === 0) {
      if (!formattedRun) {
        // Cursor pagination — fetch run details for context
        const runResult = await apiClient.retrieveRun(input.runId);
        formattedRun = formatRun(runResult);
        runUrl = await ctx.getDashboardUrl(`/projects/v3/${projectRef}/runs/${runResult.id}`);
      }

      content.push("## Run Details");
      content.push(formattedRun);
      content.push("");
    }

    content.push(
      `## Run Trace (lines ${offset + 1}-${offset + page.lines.length} of ${cached.totalLines})`
    );
    content.push(page.lines.join("\n"));

    if (page.hasMore) {
      content.push("");
      content.push(
        `**More trace available.** Call \`get_run_details\` again with \`cursor: "${page.nextCursor}"\` and \`runId: "${input.runId}"\` to see the next page.`
      );
    }

    if (runUrl && offset === 0) {
      content.push("");
      content.push(`[View in dashboard](${runUrl})`);
    }

    return {
      content: [
        {
          type: "text",
          text: content.join("\n"),
        },
      ],
    };
  }),
};

export const getSpanDetailsTool = {
  name: toolsMetadata.get_span_details.name,
  title: toolsMetadata.get_span_details.title,
  description: toolsMetadata.get_span_details.description,
  inputSchema: GetSpanDetailsInput.shape,
  handler: toolHandler(GetSpanDetailsInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling get_span_details", { input });

    if (ctx.options.devOnly && input.environment !== "dev") {
      return respondWithError(
        `This MCP server is only available for the dev environment. You tried to access the ${input.environment} environment. Remove the --dev-only flag to access other environments.`
      );
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: [`read:runs:${input.runId}`],
      branch: input.branch,
    });

    const spanDetail = await apiClient.retrieveSpan(input.runId, input.spanId);
    const formatted = formatSpanDetail(spanDetail);

    const runUrl = await ctx.getDashboardUrl(
      `/projects/v3/${projectRef}/runs/${input.runId}`
    );

    const content = [formatted];
    if (runUrl) {
      content.push("");
      content.push(`[View run in dashboard](${runUrl})`);
    }

    return {
      content: [{ type: "text", text: content.join("\n") }],
    };
  }),
};

export const waitForRunToCompleteTool = {
  name: toolsMetadata.wait_for_run_to_complete.name,
  title: toolsMetadata.wait_for_run_to_complete.title,
  description: toolsMetadata.wait_for_run_to_complete.description,
  inputSchema: WaitForRunInput.shape,
  handler: toolHandler(WaitForRunInput.shape, async (input, { ctx, signal }) => {
    ctx.logger?.log("calling wait_for_run_to_complete", { input });

    if (ctx.options.devOnly && input.environment !== "dev") {
      return respondWithError(
        `This MCP server is only available for the dev environment. You tried to access the ${input.environment} environment. Remove the --dev-only flag to access other environments.`
      );
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: [`read:runs:${input.runId}`],
      branch: input.branch,
    });

    const timeoutMs = input.timeoutInSeconds * 1000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    const runSubscription = apiClient.subscribeToRun(input.runId, { signal: combinedSignal });
    const readableStream = runSubscription.getReader();

    let run: AnyRunShape | null = null;
    let timedOut = false;

    try {
      while (true) {
        const { done, value } = await readableStream.read();
        if (done) {
          break;
        }
        run = value;

        if (value.isCompleted) {
          break;
        }
      }
    } catch (error) {
      if (timeoutSignal.aborted) {
        timedOut = true;
      } else {
        throw error;
      }
    }

    if (!run) {
      return respondWithError("Run not found");
    }

    const prefix = timedOut
      ? `Timed out after ${input.timeoutInSeconds}s. Returning current run state:\n\n`
      : "";

    return {
      content: [{ type: "text", text: prefix + formatRunShape(run) }],
    };
  }),
};

export const cancelRunTool = {
  name: toolsMetadata.cancel_run.name,
  title: toolsMetadata.cancel_run.title,
  description: toolsMetadata.cancel_run.description,
  inputSchema: CommonRunsInput.shape,
  handler: toolHandler(CommonRunsInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling cancel_run", { input });

    if (ctx.options.devOnly && input.environment !== "dev") {
      return respondWithError(
        `This MCP server is only available for the dev environment. You tried to access the ${input.environment} environment. Remove the --dev-only flag to access other environments.`
      );
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: [`write:runs:${input.runId}`, `read:runs:${input.runId}`],
      branch: input.branch,
    });

    await apiClient.cancelRun(input.runId);

    const retrieveResult = await apiClient.retrieveRun(input.runId);

    const runUrl = await ctx.getDashboardUrl(
      `/projects/v3/${projectRef}/runs/${retrieveResult.id}`
    );

    const content = [
      `Run ${retrieveResult.id} canceled.`,
      `Status: ${retrieveResult.status}`,
      `Task: ${retrieveResult.taskIdentifier}`,
      `[View in dashboard](${runUrl})`,
    ];

    return {
      content: [{ type: "text", text: content.join("\n") }],
    };
  }),
};

export const listRunsTool = {
  name: toolsMetadata.list_runs.name,
  title: toolsMetadata.list_runs.title,
  description: toolsMetadata.list_runs.description,
  inputSchema: ListRunsInput.shape,
  handler: toolHandler(ListRunsInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling list_runs", { input });

    if (ctx.options.devOnly && input.environment !== "dev") {
      return respondWithError(
        `This MCP server is only available for the dev environment. You tried to access the ${input.environment} environment. Remove the --dev-only flag to access other environments.`
      );
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["read:runs"],
      branch: input.branch,
    });

    const $from = typeof input.from === "string" ? new Date(input.from) : undefined;
    const $to = typeof input.to === "string" ? new Date(input.to) : undefined;

    const result = await apiClient.listRuns({
      after: input.cursor,
      limit: input.limit,
      status: input.status,
      taskIdentifier: input.taskIdentifier,
      version: input.version,
      tag: input.tag,
      from: $from,
      to: $to,
      period: input.period,
      machine: input.machine,
      region: input.region,
    });

    const formattedRuns = formatRunList(result);

    return {
      content: [{ type: "text", text: formattedRuns }],
    };
  }),
};
