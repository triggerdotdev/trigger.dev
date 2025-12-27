import { ListPreviewBranchesInput } from "../schemas.js";
import { toolsMetadata } from "../config.js";
import { ToolMeta } from "../types.js";
import { respondWithError, toolHandler } from "../utils.js";

export const listPreviewBranchesTool = {
  name: toolsMetadata.list_preview_branches.name,
  title: toolsMetadata.list_preview_branches.title,
  description: toolsMetadata.list_preview_branches.description,
  readOnlyHint: true,
  destructiveHint: false,
  inputSchema: ListPreviewBranchesInput.shape,
  handler: toolHandler(ListPreviewBranchesInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling list_preview_branches", { input });

    if (ctx.options.devOnly) {
      return respondWithError(`This MCP server is only available for the dev environment. `);
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const cliApiClient = await ctx.getCliApiClient();

    const branches = await cliApiClient.listBranches(projectRef);

    if (!branches.success) {
      return respondWithError(branches.error);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(branches.data, null, 2) }],
    };
  }),
};
