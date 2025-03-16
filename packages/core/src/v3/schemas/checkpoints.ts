import { CheckpointType } from "./runEngine.js";
import z from "zod";

const CallbackUrl = z
  .string()
  .url()
  .transform((url) => new URL(url));

export const CheckpointServiceSuspendRequestBody = z.object({
  type: CheckpointType,
  containerId: z.string(),
  simulate: z.boolean().optional(),
  leaveRunning: z.boolean().optional(),
  reason: z.string().optional(),
  callbacks: z
    .object({
      /** These headers will sent to all callbacks */
      headers: z.record(z.string()).optional(),
      /** This will be hit before suspending the container. Suspension will proceed unless we receive an error response. */
      preSuspend: CallbackUrl.optional(),
      /** This will be hit after suspending or failure to suspend the container */
      completion: CallbackUrl.optional(),
    })
    .optional(),
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

export const CheckpointServiceRestoreRequestBody = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(CheckpointType.Enum.DOCKER),
    containerId: z.string(),
  }),
  z.object({
    type: z.literal(CheckpointType.Enum.KUBERNETES),
    containerId: z.string(),
  }),
]);

export type CheckpointServiceRestoreRequestBody = z.infer<
  typeof CheckpointServiceRestoreRequestBody
>;
export type CheckpointServiceRestoreRequestBodyInput = z.input<
  typeof CheckpointServiceRestoreRequestBody
>;
