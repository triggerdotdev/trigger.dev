import { tool } from "ai";
import { aggregateRuns as aggregateRunsSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";

export function createAggregateRunsTool(ctx: ToolContext) {
  return tool({
    ...aggregateRunsSchema,
    execute: async (params: { groupBy: string; metric?: string; period?: string }) => {
      // TODO: Implement using ClickHouse aggregation queries
      return {
        groupBy: params.groupBy,
        results: [] as Array<Record<string, unknown>>,
        message: "aggregateRuns implementation pending",
      };
    },
  });
}
