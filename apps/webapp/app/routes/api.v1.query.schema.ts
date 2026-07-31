import { json } from "@remix-run/server-runtime";
import type { ColumnSchema, TableSchema } from "@internal/tsql";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { listableQuerySchemas } from "~/v3/querySchemas";
import { env } from "~/env.server";

function serializeColumn(col: ColumnSchema) {
  const result: Record<string, unknown> = {
    name: col.name,
    type: col.type,
  };

  if (col.description) {
    result.description = col.description;
  }
  if (col.example) {
    result.example = col.example;
  }
  if (col.allowedValues && col.allowedValues.length > 0) {
    if (col.valueMap) {
      result.allowedValues = Object.values(col.valueMap);
    } else {
      result.allowedValues = col.allowedValues;
    }
  }
  if (col.coreColumn) {
    result.coreColumn = true;
  }

  return result;
}

function serializeTable(table: TableSchema) {
  const columns = Object.values(table.columns).map(serializeColumn);

  return {
    name: table.name,
    description: table.description,
    timeColumn: table.timeConstraint,
    columns,
  };
}

export const loader = createLoaderApiRoute(
  {
    allowJWT: true,
    corsStrategy: "all",
    findResource: async () => 1,
    authorization: {
      action: "read",
      resource: () => ({ type: "query", id: "schema" }),
    },
  },
  async () => {
    const tables = listableQuerySchemas({
      includeQueueMetrics: env.QUEUE_METRICS_QUERY_TABLES_VISIBLE === "1",
    }).map(serializeTable);
    return json({ tables });
  }
);
