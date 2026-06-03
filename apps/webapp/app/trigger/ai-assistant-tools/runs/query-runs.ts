import { tool } from "ai";
import { queryRuns as queryRunsSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";

export function createQueryRunsTool(ctx: ToolContext) {
  return tool({
    ...queryRunsSchema,
    execute: async (params: { question: string }) => {
      // TODO: Wrap AIQueryService
      return {
        query: "",
        results: [],
        message: "queryRuns implementation pending",
      };
    },
  });
}
