import {
  CONCURRENCY_LIMIT_NAME_PATTERN,
  parseNaturalLanguageDurationInMs,
} from "@trigger.dev/core/v3/isomorphic";
import { MachinePresetName } from "@trigger.dev/core/v3/schemas";
import { z } from "zod";
import { resolveIdempotencyKeyTTL } from "~/utils/idempotencyKeys.server";
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

const DURATION = /^(\d+(w|d|hr|h|m|s))+$/;
const DURATION_MESSAGE = "Must be a duration like 5s, 1m or 2h30m";

/** Whether the trigger API can turn this ttl into the key's expiry date. */
const idempotencyKeyTtlFits = (ttl: string) =>
  !/^\d+[smhd]$/.test(ttl) || resolveIdempotencyKeyTTL(ttl) !== undefined;

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
      idempotencyKeyTTL: z
        .string()
        .regex(/^\d+[smhd]$/, "Must be a number followed by s, m, h or d, like 30m")
        .refine(
          idempotencyKeyTtlFits,
          "Too long: the key would expire after the latest date the server can store"
        )
        .describe(
          "How long the idempotency key returns the same run instead of a new one: a number followed by s, m, h or d, like 30m or 1d. Defaults to 30 days. Only used with idempotencyKey"
        )
        .optional(),
      concurrencyKey: z
        .string()
        .max(1024)
        .describe(
          "Gives each value of this key its own copy of the run's queue, so the queue's concurrency limit applies per key, e.g. per user id. It also keys the run's named concurrency limits"
        )
        .optional(),
      concurrency: z
        .array(
          z
            .string()
            .regex(
              CONCURRENCY_LIMIT_NAME_PATTERN,
              "Concurrency limit names are 1-122 characters using only letters, numbers, underscores and hyphens"
            )
        )
        .max(2)
        .describe(
          "Replaces the task's declared named concurrency limits for this run with these limit names, up to 2. An empty array removes all of them. The task's own inline concurrency limit still applies"
        )
        .optional(),
      debounce: z
        .object({
          key: z
            .string()
            .max(512)
            .describe("Triggers of this task with the same key are collapsed into one run"),
          delay: z
            .string()
            .max(64)
            .regex(DURATION, DURATION_MESSAGE)
            .describe(
              "How long the run waits before it starts, as a duration like 5s, 1m or 2h30m. Each new trigger with the same key moves the start to that trigger's time plus this delay"
            ),
          mode: z
            .enum(["leading", "trailing"])
            .describe(
              "leading (the default) runs with the first trigger's data. trailing updates the run from each later trigger: payload, metadata, tags, maxAttempts, maxDuration and machine"
            )
            .optional(),
          maxDelay: z
            .string()
            .max(64)
            .regex(DURATION, DURATION_MESSAGE)
            .describe(
              "The longest the start can be pushed back from the first trigger, as a duration longer than delay, like 5m. Without it, steady triggers keep pushing the run back"
            )
            .optional(),
        })
        .refine(
          (debounce) =>
            debounce.maxDelay === undefined ||
            (parseNaturalLanguageDurationInMs(debounce.maxDelay) ?? 0) >
              (parseNaturalLanguageDurationInMs(debounce.delay) ?? 0),
          { message: "debounce.maxDelay must be longer than debounce.delay", path: ["maxDelay"] }
        )
        .describe("Debounce triggers of this task that share a key into one run")
        .optional(),
      lockToVersion: z
        .string()
        .regex(/^\d{8}\.\d{1,9}$/, "Must be a deployed version like 20250101.1")
        .describe(
          "Run on this deployed version, e.g. 20250101.1, instead of the version that is current when the run starts"
        )
        .optional(),
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
      metadata: z
        .record(z.string(), z.any())
        .describe("Metadata to attach to the task run, as a JSON object")
        .optional(),
      priority: z
        .number()
        .describe(
          "Priority as a time offset in seconds: the run is dequeued as if triggered this many seconds earlier, so higher values run sooner. The server clamps very large values"
        )
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
          "The time to live of the task run. If the run doesn't start executing within this time, it will be automatically cancelled. When omitted, the task's own ttl applies, otherwise 10 minutes in dev. If the server sets a maximum ttl (14 days on Trigger.dev Cloud), a run without a ttl gets that maximum and longer ttls are capped at it; without a maximum it never expires."
        )
        .optional(),
    })
    .optional(),
});

export type TriggerTaskInput = z.output<typeof TriggerTaskInput>;

export const BATCH_TRIGGER_MAX_ITEMS = 20;

export const BatchTriggerTasksInput = CommonProjectsInput.extend({
  items: z
    .array(
      z.object({
        taskId: TriggerTaskInput.shape.taskId,
        payload: TriggerTaskInput.shape.payload,
        options: TriggerTaskInput.shape.options,
      })
    )
    .min(1)
    .max(BATCH_TRIGGER_MAX_ITEMS)
    .describe(
      `The runs to create, one per item, each with the same fields and options as trigger_task. Up to ${BATCH_TRIGGER_MAX_ITEMS} items.`
    ),
});

export type BatchTriggerTasksInput = z.output<typeof BatchTriggerTasksInput>;

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
