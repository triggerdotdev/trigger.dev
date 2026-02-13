import { TypeOf, z } from "zod";

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
export const QueryExecuteJSONResponseBody = z.object({
  format: z.literal("json"),
  results: z.array(z.record(z.any())),
});

export type QueryExecuteJSONResponseBody = z.infer<typeof QueryExecuteResponseBody>;

/**
 * Response body type for CSV format queries
 */
export const QueryExecuteCSVResponseBody = z.object({
  format: z.literal("json"),
  results: z.string(),
});

export type QueryExecuteCSVResponseBody = z.infer<typeof QueryExecuteCSVResponseBody>;

export const QueryExecuteResponseBody = z.discriminatedUnion("format", [
  QueryExecuteJSONResponseBody,
  QueryExecuteCSVResponseBody,
]);
export type QueryExecuteResponseBody = z.infer<typeof QueryExecuteResponseBody>;
