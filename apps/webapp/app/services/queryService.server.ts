import { executeTSQL, type ExecuteTSQLOptions, type TSQLQueryResult } from "@internal/clickhouse";
import type { TableSchema } from "@internal/tsql";
import { type z } from "zod";
import { clickhouseClient } from "./clickhouseInstance.server";

export type { TableSchema, TSQLQueryResult };

/**
 * Execute a TSQL query against ClickHouse with tenant isolation
 */
export async function executeQuery<TOut extends z.ZodSchema>(
  options: Omit<ExecuteTSQLOptions<TOut>, "tableSchema"> & { tableSchema: TableSchema[] }
): Promise<TSQLQueryResult<z.output<TOut>>> {
  return executeTSQL(clickhouseClient.reader, options);
}
