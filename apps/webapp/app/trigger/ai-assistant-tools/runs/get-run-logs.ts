import { tool } from "ai";
import { getRunLogs as getRunLogsSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";

export function createGetRunLogsTool(ctx: ToolContext) {
  return tool({
    ...getRunLogsSchema,
    execute: async (params: { runFriendlyId: string; level?: string; limit?: number }) => {
      // TODO: Implement by fetching from event repository
      return {
        runFriendlyId: params.runFriendlyId,
        logs: [] as string[],
        message: "getRunLogs implementation pending",
      };
    },
  });
}
