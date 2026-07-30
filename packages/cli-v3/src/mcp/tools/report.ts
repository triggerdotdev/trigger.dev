import { toolsMetadata } from "../config.js";
import { GetReportInput } from "../schemas.js";
import { respondWithError, toolHandler } from "../utils.js";

/**
 * `get_report` fetches a server-rendered report (verdict + text + sparklines). Plain
 * markdown by default, or ANSI when `color` is set (for hosts that display escapes in
 * tool output). Read-only; the handler enforces devOnly.
 */
export const getReportTool = {
  name: toolsMetadata.get_report.name,
  title: toolsMetadata.get_report.title,
  description: toolsMetadata.get_report.description,
  inputSchema: GetReportInput.shape,
  handler: toolHandler(GetReportInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling get_report", { input });

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
      scopes: ["read:query"],
      branch: input.branch,
    });

    const text = await apiClient.getReport(input.key, {
      period: input.period,
      format: input.color ? "ansi" : "markdown",
    });

    return {
      content: [{ type: "text" as const, text }],
    };
  }),
};
