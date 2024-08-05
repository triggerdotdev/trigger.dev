import { z } from "zod";
import { SerializableJsonSchema } from "./json.js";
import { RunStatusSchema } from "./runs.js";

export const StatusUpdateStateSchema = z.union([
  z.literal("loading"),
  z.literal("success"),
  z.literal("failure"),
]);
export type StatusUpdateState = z.infer<typeof StatusUpdateStateSchema>;

const StatusUpdateDataSchema = z.record(SerializableJsonSchema);
export type StatusUpdateData = z.infer<typeof StatusUpdateDataSchema>;

export const StatusUpdateSchema = z.object({
  label: z.string().optional(),
  state: StatusUpdateStateSchema.optional(),
  data: StatusUpdateDataSchema.optional(),
});
export type StatusUpdate = z.infer<typeof StatusUpdateSchema>;

const InitalStatusUpdateSchema = StatusUpdateSchema.required({ label: true });
export type InitialStatusUpdate = z.infer<typeof InitalStatusUpdateSchema>;

export const StatusHistorySchema = z.array(StatusUpdateSchema);
export type StatusHistory = z.infer<typeof StatusHistorySchema>;

export const JobRunStatusRecordSchema = InitalStatusUpdateSchema.extend({
  key: z.string(),
  history: StatusHistorySchema,
});

export type JobRunStatusRecord = z.infer<typeof JobRunStatusRecordSchema>;
