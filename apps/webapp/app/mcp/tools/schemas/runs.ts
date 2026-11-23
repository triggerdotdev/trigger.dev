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
    .describe(
      "Filter for runs that match this version, e.g. 20250808.3. Separate several versions with commas, e.g. 20250808.3,20250809.1"
    )
    .optional(),
  tag: z.string().describe("Filter for runs that include this tag").optional(),
  from: z
    .string()
    .describe("Filter for runs created after this ISO 8601 timestamp. Ignored when period is set")
    .optional(),
  to: z
    .string()
    .describe("Filter for runs created before this ISO 8601 timestamp. Ignored when period is set")
    .optional(),
  period: z
    .string()
    .describe(
      "Filter for runs created in the last N time period. e.g. 7d, 30d, 365d. Takes precedence: when period is set, from and to are ignored"
    )
    .optional(),
  machine: MachinePresetName.describe("Filter for runs that match this machine preset").optional(),
  region: z
    .string()
    .describe(
      "Filter for runs that executed in this region (the worker instance group masterQueue identifier, e.g. 'us-east-1' or 'main')"
    )
    .optional(),
  queue: z
    .string()
    .describe("Filter for runs in this queue, e.g. task/my-task or a custom queue name")
    .optional(),
  batch: z.string().describe("Filter for runs in this batch, starts with batch_").optional(),
  schedule: z
    .string()
    .describe("Filter for runs triggered by this schedule, starts with sched_")
    .optional(),
  bulkAction: z
    .string()
    .describe("Filter for runs in this bulk action, starts with bulk_")
    .optional(),
});

export type ListRunsInput = z.output<typeof ListRunsInput>;

export const ListRunTagsInput = CommonProjectsInput.extend({
  name: z.string().describe("Only list tags that contain this text (case-insensitive)").optional(),
  period: z
    .string()
    .describe("Only list tags used on runs created in the last N time period, e.g. 1d, 7d, 30d")
    .default("7d"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .describe("The number of tags to list. Up to 100, defaults to 25")
    .default(25),
});

export type ListRunTagsInput = z.output<typeof ListRunTagsInput>;
