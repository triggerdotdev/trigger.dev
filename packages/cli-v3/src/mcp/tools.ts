import { McpContext } from "./context.js";
import { deployTool, listDeploysTool } from "./tools/deploys.js";
import { searchDocsTool } from "./tools/docs.js";
import {
  createProjectInOrgTool,
  initializeProjectTool,
  listOrgsTool,
  listProjectsTool,
} from "./tools/orgs.js";
import { listPreviewBranchesTool } from "./tools/previewBranches.js";
import { cancelRunTool, getRunDetailsTool, listRunsTool } from "./tools/runs.js";
import { getCurrentWorker, triggerTaskTool } from "./tools/tasks.js";
import { respondWithError } from "./utils.js";

export function registerTools(context: McpContext) {
  const tools = [
    searchDocsTool,
    listOrgsTool,
    listProjectsTool,
    createProjectInOrgTool,
    initializeProjectTool,
    getCurrentWorker,
    triggerTaskTool,
    listRunsTool,
    getRunDetailsTool,
    cancelRunTool,
    deployTool,
    listDeploysTool,
    listPreviewBranchesTool,
  ];

  for (const tool of tools) {
    context.server.registerTool(
      tool.name,
      {
        annotations: { title: tool.title },
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
