import { tool } from "ai";
import { getRunGraph as getRunGraphSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext, RunSummary } from "../types";

export function createGetRunGraphTool(ctx: ToolContext) {
  return tool({
    ...getRunGraphSchema,
    execute: async (params: { runFriendlyId: string }) => {
      // TODO: Implement by walking span tree from RunPresenter data
      return {
        root: {} as RunSummary,
        children: [] as RunSummary[],
        message: "getRunGraph implementation pending",
      };
    },
  });
}
