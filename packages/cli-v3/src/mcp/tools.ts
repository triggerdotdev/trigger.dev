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
  getSpanDetailsTool,
  listRunsTool,
  waitForRunToCompleteTool,
} from "./tools/runs.js";
import { getCurrentWorker, getTaskSchemaTool, triggerTaskTool } from "./tools/tasks.js";
import {
  listPromptsTool,
  getPromptVersionsTool,
  promotePromptVersionTool,
  createPromptOverrideTool,
  updatePromptOverrideTool,
  removePromptOverrideTool,
  reactivatePromptOverrideTool,
} from "./tools/prompts.js";
import { listAgentsTool } from "./tools/agents.js";
import {
  startAgentChatTool,
  sendAgentMessageTool,
  closeAgentChatTool,
} from "./tools/agentChat.js";
import { respondWithError } from "./utils.js";

/** Tool names that perform write/mutating operations. */
const WRITE_TOOLS = new Set([
  deployTool.name,
  triggerTaskTool.name,
  cancelRunTool.name,
  createProjectInOrgTool.name,
  initializeProjectTool.name,
  promotePromptVersionTool.name,
  createPromptOverrideTool.name,
  updatePromptOverrideTool.name,
  removePromptOverrideTool.name,
  reactivatePromptOverrideTool.name,
  startAgentChatTool.name,
  sendAgentMessageTool.name,
  closeAgentChatTool.name,
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
    getSpanDetailsTool,
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
    listPromptsTool,
    getPromptVersionsTool,
    promotePromptVersionTool,
    createPromptOverrideTool,
    updatePromptOverrideTool,
    removePromptOverrideTool,
    reactivatePromptOverrideTool,
    listAgentsTool,
    startAgentChatTool,
    sendAgentMessageTool,
    closeAgentChatTool,
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
