import { toolsMetadata } from "../config.js";
import { formatRun, formatRunList, formatRunTrace } from "../formatters.js";
import { CommonRunsInput, GetRunDetailsInput, ListRunsInput } from "../schemas.js";
import { respondWithError, toolHandler } from "../utils.js";

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

    const [runResult, traceResult] = await Promise.all([
      apiClient.retrieveRun(input.runId),
      apiClient.retrieveRunTrace(input.runId),
    ]);

    const formattedRun = formatRun(runResult);
    const formattedTrace = formatRunTrace(traceResult.trace);

    const runUrl = await ctx.getDashboardUrl(`/projects/v3/${projectRef}/runs/${runResult.id}`);

    const content = [
      "## Run Details",
      formattedRun,
      "",
      "## Run Trace",
      formattedTrace,
      "",
      `[View in dashboard](${runUrl})`,
    ];

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

    return {
      content: [{ type: "text", text: JSON.stringify({ ...retrieveResult, runUrl }, null, 2) }],
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
    });

    const formattedRuns = formatRunList(result);

    return {
      content: [{ type: "text", text: formattedRuns }],
    };
  }),
};
