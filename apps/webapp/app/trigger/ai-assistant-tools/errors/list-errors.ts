import { tool } from "ai";
import { listErrors as listErrorsSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext, ErrorGroupSummary } from "../types";

export function createListErrorsTool(ctx: ToolContext) {
  return tool({
    ...listErrorsSchema,
    execute: async (params: { period?: string; taskIdentifier?: string; limit?: number }) => {
      // TODO: Implement using ErrorsListPresenter
      return {
        errors: [] as ErrorGroupSummary[],
        total: 0,
        message: "listErrors implementation pending",
      };
    },
  });
}
