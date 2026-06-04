import { tool } from "ai";
import { searchApi as searchApiSchema, callApi as callApiSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";
import { searchApi, getOperation, isReadOnlyOperation } from "./search";
import { executeApiCall } from "./execute";

export function createSearchApiTool(_ctx: ToolContext) {
  return tool({
    ...searchApiSchema,
    execute: async ({ query }) => {
      const results = searchApi(query, 5);
      if (results.length === 0) {
        return { found: false, message: "No matching API operations. Try different keywords." };
      }
      return { found: true, results };
    },
  });
}

export function createCallApiTool(ctx: ToolContext) {
  return tool({
    ...callApiSchema,
    // State-changing (and secret-revealing) operations pause for an explicit
    // user yes/no in the UI before execute() runs. Read-only operations run
    // immediately. The AI SDK drives this from the tool's `needsApproval`.
    needsApproval: async ({ operationId }) => {
      const operation = getOperation(operationId);
      return operation ? !isReadOnlyOperation(operation) : false;
    },
    execute: async ({ operationId, params }) => {
      return executeApiCall({
        operationId,
        params: params ?? {},
        clientData: ctx.clientData,
      });
    },
  });
}
