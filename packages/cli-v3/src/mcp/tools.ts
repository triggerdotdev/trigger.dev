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
import {
  cancelRunTool,
  getRunDetailsTool,
  listRunsTool,
  waitForRunToCompleteTool,
} from "./tools/runs.js";
import { getCurrentWorker, triggerTaskTool } from "./tools/tasks.js";
import { respondWithError } from "./utils.js";

export function registerTools(context: McpContext) {
  // Always available read-only tools
  const readOnlyTools = [
    searchDocsTool,
    listOrgsTool,
    listProjectsTool,
    getCurrentWorker,
    listRunsTool,
    getRunDetailsTool,
    waitForRunToCompleteTool,
    listPreviewBranchesTool,
    listDeploysTool, // This is a read operation, not a write
  ];

  // Write tools that are disabled in readonly mode
  const writeTools = [
    createProjectInOrgTool,
    initializeProjectTool,
    triggerTaskTool,
    cancelRunTool,
  ];

  // Deployment tools that can be independently disabled
  const deploymentTools = [
    deployTool, // Only the actual deploy command is a write operation
  ];

  let tools = [...readOnlyTools];

  // Add write tools if not in readonly mode
  if (!context.options.readonly) {
    tools = [...tools, ...writeTools];
  }

  // Add deployment tools if not disabled and not in readonly mode
  if (!context.options.disableDeployment && !context.options.readonly) {
    tools = [...tools, ...deploymentTools];
  }

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
