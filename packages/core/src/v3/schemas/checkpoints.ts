import { CheckpointType, DequeuedMessage } from "./runEngine.js";
import z from "zod";

const CallbackUrl = z
  .string()
  .url()
  .transform((url) => new URL(url));

export const CheckpointServiceSuspendRequestBody = z.object({
  type: CheckpointType,
  runId: z.string(),
  snapshotId: z.string(),
  runnerId: z.string(),
  projectRef: z.string(),
  deploymentVersion: z.string(),
  reason: z.string().optional(),
});

export type CheckpointServiceSuspendRequestBody = z.infer<
  typeof CheckpointServiceSuspendRequestBody
>;
export type CheckpointServiceSuspendRequestBodyInput = z.input<
  typeof CheckpointServiceSuspendRequestBody
>;

export const CheckpointServiceSuspendResponseBody = z.object({
  ok: z.literal(true),
});

export type CheckpointServiceSuspendResponseBody = z.infer<
  typeof CheckpointServiceSuspendResponseBody
>;

export const CheckpointServiceRestoreRequestBody = DequeuedMessage.required({ checkpoint: true });

export type CheckpointServiceRestoreRequestBody = z.infer<
  typeof CheckpointServiceRestoreRequestBody
>;
export type CheckpointServiceRestoreRequestBodyInput = z.input<
  typeof CheckpointServiceRestoreRequestBody
>;
