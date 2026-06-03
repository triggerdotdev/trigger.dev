import { tool } from "ai";
import { getErrorDetails as getErrorDetailsSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext, ErrorDetailsSummary } from "../types";

export function createGetErrorDetailsTool(ctx: ToolContext) {
  return tool({
    ...getErrorDetailsSchema,
    execute: async (params: { fingerprint: string }) => {
      // TODO: Implement using ErrorGroupPresenter
      const emptyResult: ErrorDetailsSummary = {
        fingerprint: params.fingerprint,
        message: "",
        taskIdentifier: "",
        stackTrace: undefined,
        count: 0,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        affectedRuns: [],
      };
      return emptyResult;
    },
  });
}
