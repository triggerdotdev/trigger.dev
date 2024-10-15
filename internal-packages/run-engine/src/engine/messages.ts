import { MachinePreset, EnvironmentType } from "@trigger.dev/core/v3";
import { z } from "zod";

//todo it will need to move into core because the Worker will need to use these

const ScheduleRunMessage = z.object({
  action: z.literal("SCHEDULE_RUN"),
  // The payload allows us to a discriminated union with the version
  payload: z.object({
    version: z.literal("1"),
    execution: z.object({
      id: z.string(),
      status: z.literal("DEQUEUED_FOR_EXECUTION"),
    }),
    image: z.string().optional(),
    checkpoint: z
      .object({
        id: z.string(),
        type: z.string(),
        location: z.string(),
        reason: z.string().optional(),
      })
      .optional(),
    backgroundWorker: z.object({
      id: z.string(),
      version: z.string(),
    }),
    run: z.object({
      id: z.string(),
      friendlyId: z.string(),
      isTest: z.boolean(),
      machine: MachinePreset,
      attemptNumber: z.number(),
      masterQueue: z.string(),
      traceContext: z.record(z.unknown()),
    }),
    environment: z.object({
      id: z.string(),
      type: EnvironmentType,
    }),
    organization: z.object({
      id: z.string(),
    }),
    project: z.object({
      id: z.string(),
    }),
  }),
});
export type ScheduleRunMessage = z.infer<typeof ScheduleRunMessage>;

export const Messages = z.discriminatedUnion("action", [ScheduleRunMessage]);
