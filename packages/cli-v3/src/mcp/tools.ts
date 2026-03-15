import { McpContext } from "./context.js";
import { deployTool, listDeploysTool } from "./tools/deploys.js";
import { searchDocsTool } from "./tools/docs.js";
import {
  createProjectInOrgTool,
  initializeProjectTool,
  listOrgsTool,
  listProjectsTool,
} from "./tools/orgs.js";
import { listDashboardsTool, runDashboardQueryTool } from "./tools/dashboards.js";
import { startDevServerTool, stopDevServerTool, devServerStatusTool } from "./tools/devServer.js";
import { listPreviewBranchesTool } from "./tools/previewBranches.js";
import { listProfilesTool, switchProfileTool, whoamiTool } from "./tools/profiles.js";
import { getQuerySchemaTool, queryTool } from "./tools/query.js";
import {
  cancelRunTool,
  getRunDetailsTool,
  listRunsTool,
  waitForRunToCompleteTool,
} from "./tools/runs.js";
import { getCurrentWorker, getTaskSchemaTool, triggerTaskTool } from "./tools/tasks.js";
import { respondWithError } from "./utils.js";

/** Tool names that perform write operations (deploy, trigger, cancel). */
const WRITE_TOOLS = new Set([
  deployTool.name,
  triggerTaskTool.name,
  cancelRunTool.name,
]);

export function registerTools(context: McpContext) {
  const tools = [
    searchDocsTool,
    listOrgsTool,
    listProjectsTool,
    createProjectInOrgTool,
    initializeProjectTool,
    getCurrentWorker,
    getTaskSchemaTool,
    triggerTaskTool,
    listRunsTool,
    getRunDetailsTool,
    waitForRunToCompleteTool,
    cancelRunTool,
    deployTool,
    listDeploysTool,
    listPreviewBranchesTool,
    getQuerySchemaTool,
    queryTool,
    listDashboardsTool,
    runDashboardQueryTool,
    whoamiTool,
    listProfilesTool,
    switchProfileTool,
    startDevServerTool,
    stopDevServerTool,
    devServerStatusTool,
  ];

  for (const tool of tools) {
    // In readonly mode, skip write tools entirely so the LLM never sees them
    if (context.options.readonly && WRITE_TOOLS.has(tool.name)) {
      continue;
    }

    const isWrite = WRITE_TOOLS.has(tool.name);

    context.server.registerTool(
      tool.name,
      {
        annotations: {
          title: tool.title,
          readOnlyHint: !isWrite,
          destructiveHint: isWrite,
        },
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (input, extra) => {
        try {
          return tool.handler(input, { ...extra, ctx: context });
        } catch (error) {
          return respondWithError(error);
        }
      }
    );
  }
}
