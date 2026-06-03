import { tool } from "ai";
import { summarizeCurrentView as summarizeCurrentViewSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";

export function createSummarizeCurrentViewTool(ctx: ToolContext) {
  return tool({
    ...summarizeCurrentViewSchema,
    execute: async (params: { period?: string }) => {
      // TODO: Implement using ClickHouse queries
      return {
        totalRuns: 0,
        statusDistribution: {},
        topFailingTasks: [] as string[],
        errorRate: "0%",
        message: "summarizeCurrentView implementation pending",
      };
    },
  });
}
