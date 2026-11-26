import { z } from "zod";
import { LogLevelSchema } from "~/utils/logUtils";
import { CURSOR_CHARS, HANDLE_CHARS } from "../format/logFields";
import { CommonProjectsInput } from "./common";

export const SearchLogsInput = CommonProjectsInput.extend({
  search: z
    .string()
    .max(1000)
    .describe("Only return logs whose message or attributes contain this text")
    .optional(),
  levels: z
    .array(LogLevelSchema)
    .describe("Only return logs at these levels: TRACE, DEBUG, INFO, WARN, ERROR")
    .optional(),
  tasks: z
    .array(z.string().max(128))
    .max(50)
    .describe("Only return logs from these task identifiers. Up to 50, each up to 128 characters")
    .optional(),
  runId: z.string().describe("Only return logs from this run, starts with run_").optional(),
  period: z
    .string()
    .describe(
      "Only return logs from the last N time period, e.g. 1h, 1d, 7d. Defaults to 1d. Pass either period or from/to, not both"
    )
    .optional(),
  from: z.string().describe("Only return logs after this ISO 8601 timestamp").optional(),
  to: z.string().describe("Only return logs before this ISO 8601 timestamp").optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .describe("The number of logs to return in a single page. Up to 100, defaults to 25")
    .default(25),
  cursor: z
    .string()
    .max(CURSOR_CHARS)
    .describe("Pagination cursor returned from a previous search_logs call with the same filters")
    .optional(),
});

export type SearchLogsInput = z.output<typeof SearchLogsInput>;

export const GetLogInput = CommonProjectsInput.extend({
  logId: z.string().max(HANDLE_CHARS).describe("The log ID returned by search_logs"),
});

export type GetLogInput = z.output<typeof GetLogInput>;
