import { tool } from "ai";
import { getRunDetails as getRunDetailsSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext, RunWithTrace } from "../types";
import { getRunForLLM } from "./run-presenter-adapter";

export function createGetRunDetailsTool(ctx: ToolContext) {
  return tool({
    ...getRunDetailsSchema,
    execute: async (params: { runFriendlyId: string }) => {
      const result = await getRunForLLM(ctx, params.runFriendlyId);
      if (!result) {
        return { error: `Run ${params.runFriendlyId} not found` };
      }
      return result as RunWithTrace;
    },
  });
}
