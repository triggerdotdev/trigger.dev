import { z } from "zod";

/**
 * Request body schema for executing a query
 */
export const QueryExecuteRequestBody = z.object({
  query: z.string(),
  scope: z.enum(["organization", "project", "environment"]).default("environment"),
  period: z.string().nullish(),
  from: z.string().nullish(),
  to: z.string().nullish(),
  format: z.enum(["json", "csv"]).default("json"),
});

export type QueryExecuteRequestBody = z.infer<typeof QueryExecuteRequestBody>;

/**
 * Response body schema for JSON format queries
 */
export const QueryExecuteResponseBody = z.object({
  rows: z.array(z.record(z.any())),
});

export type QueryExecuteResponseBody = z.infer<typeof QueryExecuteResponseBody>;

/**
 * Response body type for CSV format queries (returns a string)
 */
export type QueryExecuteCSVResponseBody = string;
