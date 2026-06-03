import { tool } from "ai";
import { classifyFailure as classifyFailureSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";

export function createClassifyFailureTool(ctx: ToolContext) {
  return tool({
    ...classifyFailureSchema,
    execute: async (params: { runFriendlyId: string }) => {
      // TODO: Implement with nested LLM call
      // Fetch run details + logs + error, then classify using generateObject
      return {
        category: "Unknown",
        confidence: "Low",
        evidence: "",
        nextSteps: [] as string[],
        message: "classifyFailure implementation pending",
      };
    },
  });
}
