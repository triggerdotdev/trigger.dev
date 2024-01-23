import { z } from "zod";
import { BackgroundWorkerMetadata, TaskResource } from "./resources";

export const WhoAmIResponseSchema = z.object({
  userId: z.string(),
  email: z.string().email(),
});

export type WhoAmIResponse = z.infer<typeof WhoAmIResponseSchema>;

export const GetProjectDevResponse = z.object({
  apiKey: z.string(),
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
});

export type TriggerTaskRequestBody = z.infer<typeof TriggerTaskRequestBody>;

export const TriggerTaskResponse = z.object({
  id: z.string(),
});

export type TriggerTaskResponse = z.infer<typeof TriggerTaskResponse>;
