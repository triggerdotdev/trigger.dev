import { MachinePresetName, RunStatus } from "@trigger.dev/core/v3/schemas";
import parseDuration from "parse-duration";
import { z } from "zod";
import { DEFAULT_RUN_PERIOD } from "../format/bulkActions";
import { CommonProjectsInput } from "./common";

const MAX_BULK_RUN_IDS = 500;
const MAX_VALUES = 100;
const VALUE_CHARS = 256;

const values = (description: string) =>
  z
    .array(z.string().min(1).max(VALUE_CHARS))
    .min(1)
    .max(MAX_VALUES)
    .describe(description)
    .optional();

export const friendlyIdPattern = (prefix: string) => new RegExp(`^${prefix}_[0-9A-Za-z]+$`);

const friendlyId = (prefix: string, description: string) =>
  z
    .string()
    .regex(friendlyIdPattern(prefix), `Must be lowercase ${prefix}_ followed by letters and digits`)
    .describe(description)
    .optional();

const isoDate = (description: string) =>
  z
    .string()
    .refine(
      (value) => Date.parse(value) > 0,
      "Must be an ISO 8601 timestamp after 1970-01-01T00:00:00Z"
    )
    .describe(description)
    .optional();

export const BulkActionFilter = z
  .object({
    status: z.array(RunStatus).min(1).describe("Runs with any of these statuses").optional(),
    taskIdentifier: values("Runs of any of these tasks"),
    version: values("Runs of any of these versions, e.g. 20250808.3"),
    tag: values("Runs that have any of these tags"),
    queue: values("Runs in any of these queues, e.g. task/my-task or a custom queue name"),
    machine: z
      .array(MachinePresetName)
      .min(1)
      .describe("Runs on any of these machine presets")
      .optional(),
    region: values("Runs that executed in any of these regions"),
    batch: friendlyId("batch", "Runs in this batch, starts with batch_"),
    schedule: friendlyId("sched", "Runs triggered by this schedule, starts with sched_"),
    bulkAction: friendlyId("bulk", "Runs in this bulk action, starts with bulk_"),
    error: friendlyId("error", "Runs that failed with this error, starts with error_"),
    rootOnly: z
      .boolean()
      .describe(
        "Only root runs, not child runs. Cannot be combined with batch or schedule, which always include child runs"
      )
      .optional(),
    from: isoDate("Runs created at or after this ISO 8601 timestamp"),
    to: isoDate("Runs created at or before this ISO 8601 timestamp"),
    period: z
      .string()
      .refine((value) => Boolean(parseDuration(value)), "Must be a duration like 1h, 7d or 30d")
      .describe(
        "Runs created in the last N time period, e.g. 1h, 7d, 30d. Use period or from/to, not both"
      )
      .optional(),
  })
  .strict()
  .superRefine((filter, ctx) => {
    if (filter.period !== undefined && (filter.from !== undefined || filter.to !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "Pass either period or from/to, not both",
      });
    }
    if (filter.rootOnly && (filter.batch !== undefined || filter.schedule !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message:
          "rootOnly cannot be combined with batch or schedule: those filters always include child runs",
      });
    }
  });

export type BulkActionFilter = z.output<typeof BulkActionFilter>;

export const ListBulkActionsInput = CommonProjectsInput.extend({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .describe("The number of bulk actions to list. Up to 100, defaults to 25")
    .default(25),
  cursor: z
    .string()
    .describe("The cursor from a previous list_bulk_actions call, to list older ones")
    .optional(),
});

export type ListBulkActionsInput = z.output<typeof ListBulkActionsInput>;

export const BulkActionIdInput = CommonProjectsInput.extend({
  bulkActionId: z.string().describe("The ID of the bulk action, starts with bulk_"),
});

export type BulkActionIdInput = z.output<typeof BulkActionIdInput>;

export const CreateBulkActionInput = CommonProjectsInput.extend({
  action: z
    .enum(["cancel", "replay"])
    .describe("cancel stops runs that have not finished; replay starts a new run for each run"),
  runIds: z
    .array(
      z
        .string()
        .regex(friendlyIdPattern("run"), "Must be lowercase run_ followed by letters and digits")
    )
    .min(1)
    .max(MAX_BULK_RUN_IDS)
    .describe(
      `Act on these runs, up to ${MAX_BULK_RUN_IDS}. Runs created more than ${DEFAULT_RUN_PERIOD} ago are skipped. Pass either runIds or filter.`
    )
    .optional(),
  filter: BulkActionFilter.describe(
    `Act on every run in the environment that matches all of these filters. Without period, from or to, only runs created in the last ${DEFAULT_RUN_PERIOD} are selected. Pass either runIds or filter.`
  ).optional(),
  name: z.string().max(VALUE_CHARS).describe("A name for the bulk action").optional(),
  region: z
    .string()
    .max(VALUE_CHARS)
    .describe("Replay only: run the new runs in this region instead of each run's own region")
    .optional(),
  emailNotification: z
    .boolean()
    .describe("Email you when the bulk action finishes. Defaults to false")
    .default(false),
});

export type CreateBulkActionInput = z.output<typeof CreateBulkActionInput>;
