import { tool } from "ai";
import { getCurrentContext as contextSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";

export function createGetCurrentContextTool(ctx: ToolContext) {
  return tool({
    ...contextSchema,
    execute: async () => {
      return {
        project: ctx.clientData.projectSlug,
        environment: ctx.clientData.environmentSlug,
        currentPage: ctx.clientData.currentPage,
        currentParams: ctx.clientData.currentParams ?? {},
        description: `The user is viewing the ${ctx.clientData.currentPage} page in project "${ctx.clientData.projectSlug}" (${ctx.clientData.environmentSlug} environment).`,
      };
    },
  });
}