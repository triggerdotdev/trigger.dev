import z from "zod";
import { McpContext } from "./context.js";

export function registerGetProjectDetailsTool(context: McpContext) {
  context.server.registerTool(
    "get_project_details",
    {
      description: "Get the details of the project",
      inputSchema: {
        projectRef: z.string().optional(),
      },
    },
    async ({ projectRef }, extra) => {
      const roots = await context.server.server.listRoots();

      context.logger?.log("get_project_details", { roots, projectRef, extra });

      return {
        content: [{ type: "text", text: "Not implemented" }],
      };
    }
  );
}
