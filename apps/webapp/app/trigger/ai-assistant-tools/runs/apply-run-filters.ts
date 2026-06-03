import { tool } from "ai";
import { applyRunFilters as applyRunFiltersSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";

export function createApplyRunFiltersTool(ctx: ToolContext) {
  return tool({
    ...applyRunFiltersSchema,
    execute: async (params: { description: string }) => {
      // TODO: Wrap AIRunFilterService
      return {
        filters: {},
        message: "applyRunFilters implementation pending",
      };
    },
  });
}
