import { tool } from "ai";
import { listRuns as listRunsSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext, RunSummary } from "../types";

export function createListRunsTool(ctx: ToolContext) {
  return tool({
    ...listRunsSchema,
    execute: async (params) => {
      // TODO: Implement using NextRunListPresenter or ClickHouse
      // For now, return a placeholder that will be filled in during implementation
      return {
        runs: [] as RunSummary[],
        total: 0,
        message: "listRuns implementation pending",
      };
    },
  });
}
