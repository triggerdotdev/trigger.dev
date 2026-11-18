import { MachinePresetName, RunStatus } from "@trigger.dev/core/v3/schemas";
import { z } from "zod";
import { CommonProjectsInput, CommonRunsInput } from "./common";

export const WaitForRunInput = CommonRunsInput.extend({
  timeoutInSeconds: z
    .number()
    .describe(
      "The maximum time in seconds to wait for the run to complete. If the run doesn't complete within this time, the current state of the run will be returned. Defaults to 60 seconds."
    )
    .default(60),
});

export type WaitForRunInput = z.output<typeof WaitForRunInput>;

export const GetRunDetailsInput = CommonRunsInput.extend({
  maxTraceLines: z
    .number()
    .int()
    .describe(
      "The maximum number of trace lines per page. Defaults to 200. Use the `cursor` parameter to fetch subsequent pages."
    )
    .default(200),
  cursor: z
    .string()
    .describe(
      "Pagination cursor returned from a previous get_run_details call. Pass this to fetch the next page of trace events."
    )
    .optional(),
});

export type GetRunDetailsInput = z.output<typeof GetRunDetailsInput>;

export const GetSpanDetailsInput = CommonRunsInput.extend({
  spanId: z
    .string()
    .describe(
      "The span ID to get details for. You can find span IDs in the trace output from get_run_details — they appear as [spanId] before each span message."
    ),
});

export type GetSpanDetailsInput = z.output<typeof GetSpanDetailsInput>;

export const ListRunsInput = CommonProjectsInput.extend({
  cursor: z.string().describe("The cursor to use for pagination, starts with run_").optional(),
  limit: z
    .number()
    .int()
    .describe("The number of runs to list in a single page. Up to 100")
    .optional(),
  status: RunStatus.describe("Filter for runs with this run status").optional(),
  taskIdentifier: z.string().describe("Filter for runs that match this task identifier").optional(),
  version: z
    .string()
    .describe("Filter for runs that match this version, e.g. 20250808.3")
    .optional(),
  tag: z.string().describe("Filter for runs that include this tag").optional(),
  from: z.string().describe("Filter for runs created after this ISO 8601 timestamp").optional(),
  to: z.string().describe("Filter for runs created before this ISO 8601 timestamp").optional(),
  period: z
    .string()
    .describe("Filter for runs created in the last N time period. e.g. 7d, 30d, 365d")
    .optional(),
  machine: MachinePresetName.describe("Filter for runs that match this machine preset").optional(),
  region: z
    .string()
    .describe(
      "Filter for runs that executed in this region (the worker instance group masterQueue identifier, e.g. 'us-east-1' or 'main')"
    )
    .optional(),
});

export type ListRunsInput = z.output<typeof ListRunsInput>;
