import { tool } from "ai";
import {
  searchApi as searchApiSchema,
  getApiDetails as getApiDetailsSchema,
  callApi as callApiSchema,
} from "~/lib/ai-assistant/tool-schemas";
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

export function createGetApiDetailsTool(_ctx: ToolContext) {
  return tool({
    ...getApiDetailsSchema,
    execute: async ({ operationId }) => {
      const operation = getOperation(operationId);
      if (!operation) {
        return {
          found: false,
          message: `Unknown operationId "${operationId}". Call searchApi to find the right one.`,
        };
      }
      const body = operation.parameters.filter((p) => p.in === "body");
      return {
        found: true,
        operationId: operation.operationId,
        method: operation.method,
        path: operation.path,
        summary: operation.summary,
        description: operation.description,
        destructive: operation.destructive,
        requiresApproval: !isReadOnlyOperation(operation),
        parameters: operation.parameters.map((p) => ({
          name: p.name,
          in: p.in,
          required: p.required,
          type: p.type,
          enum: p.enum,
          description: p.description,
          schema: p.schema,
        })),
        requiredParams: operation.requiredParams,
        body: body.length > 0 ? body : undefined,
      };
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
