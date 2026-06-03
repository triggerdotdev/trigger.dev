import { tool } from "ai";
import { getRunDetails as getRunDetailsSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";

export function createGetRunDetailsTool(ctx: ToolContext) {
  return tool({
    ...getRunDetailsSchema,
    execute: async (params: { runFriendlyId: string }) => {
      try {
        const { getRunForLLM } = await import("./run-presenter-adapter");
        const result = await getRunForLLM(ctx, params.runFriendlyId);
        if (!result) {
          return { error: `Run ${params.runFriendlyId} not found` };
        }
        return result;
      } catch (error) {
        return {
          error: `Failed to get run details: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });
}
