import { MachinePresetName } from "@trigger.dev/core/v3/schemas";
import { z } from "zod";
import { CommonProjectsInput, CommonRunsInput } from "./common";

export const CreateProjectInOrgInput = z.object({
  orgParam: z
    .string()
    .describe(
      "The organization to create the project in, can either be the organization slug or the ID. Use the list_orgs tool to get a list of organizations and ask the user to select one."
    ),
  name: z.string().describe("The name of the project to create."),
});

export type CreateProjectInOrgInput = z.output<typeof CreateProjectInOrgInput>;

export const TriggerTaskInput = CommonProjectsInput.extend({
  taskId: z
    .string()
    .describe(
      "The ID/slug of the task to trigger. Use the get_tasks tool to get a list of tasks and ask the user to select one if it's not clear which one to use."
    ),
  payload: z
    .any()
    .describe(
      "The payload to trigger the task with. Should match the task's payload schema. Not a JSON string, but the actual payload object"
    ),
  options: z
    .object({
      queue: z
        .object({
          name: z
            .string()
            .describe(
              "The name of the queue to trigger the task in, by default will use the queue configured in the task"
            ),
        })
        .optional(),
      delay: z
        .string()
        .or(z.iso.datetime())
        .describe("The delay before the task run is executed")
        .optional(),
      idempotencyKey: z.string().describe("The idempotency key to use for the task run").optional(),
      machine: MachinePresetName.describe("The machine preset to use for the task run").optional(),
      maxAttempts: z
        .number()
        .int()
        .describe("The maximum number of attempts to retry the task run")
        .optional(),
      maxDuration: z
        .number()
        .describe("The maximum duration in seconds of the task run")
        .optional(),
      region: z
        .string()
        .describe(
          "The region to run the task in, overriding the default region set for the project. Available regions are listed on the Regions page in the dashboard, and this has no effect in the dev environment"
        )
        .optional(),
      tags: z
        .array(z.string())
        .describe(
          "Tags to add to the task run. Must be less than 128 characters and cannot have more than 5"
        )
        .optional(),
      ttl: z
        .string()
        .or(z.number().nonnegative().int())
        .describe(
          "The time to live of the task run. If the run doesn't start executing within this time, it will be automatically cancelled."
        )
        .default("10m"),
    })
    .optional(),
});

export type TriggerTaskInput = z.output<typeof TriggerTaskInput>;

export const ReplayRunInput = CommonRunsInput.extend({
  payload: z
    .any()
    .describe(
      "A new payload for the replayed run, as the actual payload object (not a JSON string). Omit it to reuse the original run's payload."
    )
    .optional(),
  metadata: z
    .record(z.string(), z.any())
    .describe("New metadata for the replayed run. Omit it to reuse the original run's metadata.")
    .optional(),
  tags: z
    .array(z.string())
    .describe("Tags for the replayed run, replacing the original run's tags. Up to 10.")
    .optional(),
  queue: z
    .string()
    .describe("The name of an existing queue to run on. Omit it to use the original run's queue.")
    .optional(),
  concurrencyKey: z.string().describe("The concurrency key for the replayed run").optional(),
  machine: MachinePresetName.describe("The machine preset for the replayed run").optional(),
  version: z
    .string()
    .describe(
      "Lock the replayed run to this deployed version, e.g. 20250101.1. Defaults to the current version."
    )
    .optional(),
  region: z
    .string()
    .describe("The region to run in. Defaults to the original run's region.")
    .optional(),
  delay: z
    .string()
    .or(z.iso.datetime())
    .describe("Delay the replayed run, as a duration like 1h30m or an ISO 8601 date")
    .optional(),
  ttl: z
    .string()
    .or(z.number().nonnegative().int())
    .describe(
      "How long the replayed run can stay queued before it expires, as a duration like 10m or a number of seconds"
    )
    .optional(),
  idempotencyKey: z.string().describe("An idempotency key for the replayed run").optional(),
  maxAttempts: z
    .number()
    .int()
    .min(1)
    .describe("The maximum number of attempts for the replayed run")
    .optional(),
  maxDuration: z
    .number()
    .describe("The maximum duration in seconds of the replayed run")
    .optional(),
  priority: z
    .number()
    .describe("Priority offset in seconds. Higher values are dequeued sooner.")
    .optional(),
});

export type ReplayRunInput = z.output<typeof ReplayRunInput>;
