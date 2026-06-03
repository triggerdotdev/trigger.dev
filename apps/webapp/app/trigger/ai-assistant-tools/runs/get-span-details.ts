import { tool } from "ai";
import { getSpanDetails as getSpanDetailsSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";

export function createGetSpanDetailsTool(ctx: ToolContext) {
  return tool({
    ...getSpanDetailsSchema,
    execute: async (params: { runFriendlyId: string; spanId: string }) => {
      try {
        const { getSpanForLLM } = await import("./span-detail-adapter");
        const result = await getSpanForLLM(ctx, params.runFriendlyId, params.spanId);
        if (!result) {
          return { error: `Span ${params.spanId} not found in run ${params.runFriendlyId}` };
        }
        return result;
      } catch (error) {
        return {
          error: `Failed to get span details: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  });
}
