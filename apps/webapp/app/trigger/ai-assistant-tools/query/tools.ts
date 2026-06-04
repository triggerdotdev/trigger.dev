import { tool } from "ai";
import {
  executeTrql as executeTrqlSchema,
  getQuerySchema as getQuerySchemaSchema,
  listDashboards as listDashboardsSchema,
} from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";
import { executeApiCall } from "../api/execute";

// The query tools are typed wrappers over the `/api/v1/query*` operations in
// the registry. Routing them through executeApiCall reuses the same env-key
// auth resolution and response truncation as the rest of the API agent.

export function createExecuteTrqlTool(ctx: ToolContext) {
  return tool({
    ...executeTrqlSchema,
    execute: async ({ query, scope, period, from, to }) => {
      return executeApiCall({
        operationId: "execute_query_v1",
        params: {
          _body: {
            query,
            scope: scope ?? "environment",
            period,
            from,
            to,
            format: "json",
          },
        },
        clientData: ctx.clientData,
      });
    },
  });
}

export function createGetQuerySchemaTool(ctx: ToolContext) {
  return tool({
    ...getQuerySchemaSchema,
    execute: async () => {
      return executeApiCall({
        operationId: "get_query_schema_v1",
        params: {},
        clientData: ctx.clientData,
      });
    },
  });
}

export function createListDashboardsTool(ctx: ToolContext) {
  return tool({
    ...listDashboardsSchema,
    execute: async () => {
      return executeApiCall({
        operationId: "list_dashboards_v1",
        params: {},
        clientData: ctx.clientData,
      });
    },
  });
}
