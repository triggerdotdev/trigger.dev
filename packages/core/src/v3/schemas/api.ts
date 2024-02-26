import { z } from "zod";
import { BackgroundWorkerMetadata, ImageDetailsMetadata } from "./resources";
import { QueueOptions } from "./messages";

export const WhoAmIResponseSchema = z.object({
  userId: z.string(),
  email: z.string().email(),
});

export type WhoAmIResponse = z.infer<typeof WhoAmIResponseSchema>;

export const GetProjectDevResponse = z.object({
  apiKey: z.string(),
  name: z.string(),
});

export type GetProjectDevResponse = z.infer<typeof GetProjectDevResponse>;

export const CreateBackgroundWorkerRequestBody = z.object({
  localOnly: z.boolean(),
  metadata: BackgroundWorkerMetadata,
});

export type CreateBackgroundWorkerRequestBody = z.infer<typeof CreateBackgroundWorkerRequestBody>;

export const CreateBackgroundWorkerResponse = z.object({
  id: z.string(),
  version: z.string(),
  contentHash: z.string(),
});

export type CreateBackgroundWorkerResponse = z.infer<typeof CreateBackgroundWorkerResponse>;

export const TriggerTaskRequestBody = z.object({
  payload: z.any(),
  context: z.any(),
  options: z
    .object({
      dependentAttempt: z.string().optional(),
      dependentBatch: z.string().optional(),
      lockToVersion: z.string().optional(),
      queue: QueueOptions.optional(),
      concurrencyKey: z.string().optional(),
    })
    .optional(),
});

export type TriggerTaskRequestBody = z.infer<typeof TriggerTaskRequestBody>;

export const TriggerTaskResponse = z.object({
  id: z.string(),
});

export type TriggerTaskResponse = z.infer<typeof TriggerTaskResponse>;

export const BatchTriggerTaskRequestBody = z.object({
  items: TriggerTaskRequestBody.array(),
  dependentAttempt: z.string().optional(),
});

export type BatchTriggerTaskRequestBody = z.infer<typeof BatchTriggerTaskRequestBody>;

export const BatchTriggerTaskResponse = z.object({
  batchId: z.string(),
  runs: z.string().array(),
});

export type BatchTriggerTaskResponse = z.infer<typeof BatchTriggerTaskResponse>;

export const GetBatchResponseBody = z.object({
  id: z.string(),
  items: z.array(
    z.object({
      id: z.string(),
      taskRunId: z.string(),
      status: z.enum(["PENDING", "CANCELED", "COMPLETED", "FAILED"]),
    })
  ),
});

export type GetBatchResponseBody = z.infer<typeof GetBatchResponseBody>;

export const CreateImageDetailsRequestBody = z.object({
  metadata: ImageDetailsMetadata,
});

export type CreateImageDetailsRequestBody = z.infer<typeof CreateImageDetailsRequestBody>;

export const CreateImageDetailsResponse = z.object({
  id: z.string(),
  contentHash: z.string(),
});

export type CreateImageDetailsResponse = z.infer<typeof CreateImageDetailsResponse>;
