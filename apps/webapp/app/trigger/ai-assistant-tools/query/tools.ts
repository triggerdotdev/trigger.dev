import { tool } from "ai";
import {
  executeTrql as executeTrqlSchema,
  getTableSchema as getTableSchemaSchema,
  listDashboards as listDashboardsSchema,
} from "~/lib/ai-assistant/tool-schemas";
import { trqlTables } from "~/lib/ai-assistant/trql-schema.generated";
import type { ToolContext } from "../types";
import { executeApiCall } from "../api/execute";

const tableByName = new Map(trqlTables.map((t) => [t.name, t]));

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

export function createGetTableSchemaTool(_ctx: ToolContext) {
  return tool({
    ...getTableSchemaSchema,
    execute: async ({ table }) => {
      const found = tableByName.get(table);
      if (!found) {
        return {
          found: false,
          message: `Unknown table "${table}".`,
          availableTables: trqlTables.map((t) => t.name),
        };
      }
      return { found: true, ...found };
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
