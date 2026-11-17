import { z } from "zod";
import { CommonProjectsInput } from "./common";

export const QueryInput = CommonProjectsInput.extend({
  query: z
    .string()
    .describe(
      "The TRQL query to execute. TRQL is a SQL-style language for analyzing your Trigger.dev data. Use the get_query_schema tool first to discover available tables and columns."
    ),
  scope: z
    .enum(["environment", "project", "organization"])
    .default("environment")
    .describe(
      "Data access scope. 'environment' (default) limits to the current environment, 'project' spans all environments, 'organization' spans all projects."
    ),
  period: z
    .string()
    .optional()
    .describe("Time period shorthand, e.g. '1h', '7d', '30d'. Mutually exclusive with from/to."),
  from: z.string().optional().describe("Start of time range (ISO 8601). Must be paired with 'to'."),
  to: z.string().optional().describe("End of time range (ISO 8601). Must be paired with 'from'."),
});

export const QuerySchemaInput = CommonProjectsInput.pick({
  projectRef: true,
  configPath: true,
  environment: true,
  branch: true,
}).extend({
  table: z
    .string()
    .describe("The table name to get the schema for (e.g. 'runs', 'metrics', 'llm_metrics')."),
});
