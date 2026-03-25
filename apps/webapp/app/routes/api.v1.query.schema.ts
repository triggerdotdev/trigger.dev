import { json } from "@remix-run/server-runtime";
import type { ColumnSchema, TableSchema } from "@internal/tsql";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { querySchemas } from "~/v3/querySchemas";

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
      resource: () => ({ query: "schema" }),
      superScopes: ["read:query", "read:all", "admin"],
    },
  },
  async () => {
    const tables = querySchemas.map(serializeTable);
    return json({ tables });
  }
);
