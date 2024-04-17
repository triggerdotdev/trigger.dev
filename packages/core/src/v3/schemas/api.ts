import { z } from "zod";
import { BackgroundWorkerMetadata, ImageDetailsMetadata } from "./resources";
import { QueueOptions } from "./messages";

export const WhoAmIResponseSchema = z.object({
  userId: z.string(),
  email: z.string().email(),
  dashboardUrl: z.string(),
});

export type WhoAmIResponse = z.infer<typeof WhoAmIResponseSchema>;

export const GetProjectResponseBody = z.object({
  id: z.string(),
  externalRef: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.coerce.date(),
  organization: z.object({
    id: z.string(),
    title: z.string(),
    slug: z.string(),
    createdAt: z.coerce.date(),
  }),
});

export type GetProjectResponseBody = z.infer<typeof GetProjectResponseBody>;

export const GetProjectsResponseBody = z.array(GetProjectResponseBody);

export type GetProjectsResponseBody = z.infer<typeof GetProjectsResponseBody>;

export const GetProjectEnvResponse = z.object({
  apiKey: z.string(),
  name: z.string(),
  apiUrl: z.string(),
});

export type GetProjectEnvResponse = z.infer<typeof GetProjectEnvResponse>;

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
      idempotencyKey: z.string().optional(),
      test: z.boolean().optional(),
      payloadType: z.string().optional(),
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

export const GetEnvironmentVariablesResponseBody = z.object({
  variables: z.record(z.string()),
});

export type GetEnvironmentVariablesResponseBody = z.infer<
  typeof GetEnvironmentVariablesResponseBody
>;

export const StartDeploymentIndexingRequestBody = z.object({
  imageReference: z.string(),
});

export type StartDeploymentIndexingRequestBody = z.infer<typeof StartDeploymentIndexingRequestBody>;

export const StartDeploymentIndexingResponseBody = z.object({
  id: z.string(),
  contentHash: z.string(),
});

export type StartDeploymentIndexingResponseBody = z.infer<
  typeof StartDeploymentIndexingResponseBody
>;

export const ExternalBuildData = z.object({
  buildId: z.string(),
  buildToken: z.string(),
  projectId: z.string(),
});

export type ExternalBuildData = z.infer<typeof ExternalBuildData>;

export const InitializeDeploymentResponseBody = z.object({
  id: z.string(),
  contentHash: z.string(),
  shortCode: z.string(),
  version: z.string(),
  imageTag: z.string(),
  externalBuildData: ExternalBuildData.optional().nullable(),
  registryHost: z.string().optional(),
});

export type InitializeDeploymentResponseBody = z.infer<typeof InitializeDeploymentResponseBody>;

export const InitializeDeploymentRequestBody = z.object({
  contentHash: z.string(),
  userId: z.string().optional(),
});

export type InitializeDeploymentRequestBody = z.infer<typeof InitializeDeploymentRequestBody>;

export const DeploymentErrorData = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
});

export const GetDeploymentResponseBody = z.object({
  id: z.string(),
  status: z.enum([
    "PENDING",
    "BUILDING",
    "DEPLOYING",
    "DEPLOYED",
    "FAILED",
    "CANCELED",
    "TIMED_OUT",
  ]),
  contentHash: z.string(),
  shortCode: z.string(),
  version: z.string(),
  imageReference: z.string().optional(),
  errorData: DeploymentErrorData.optional().nullable(),
  worker: z
    .object({
      id: z.string(),
      version: z.string(),
      tasks: z.array(
        z.object({
          id: z.string(),
          slug: z.string(),
          filePath: z.string(),
          exportName: z.string(),
        })
      ),
    })
    .optional(),
});

export type GetDeploymentResponseBody = z.infer<typeof GetDeploymentResponseBody>;

export const CreateUploadPayloadUrlResponseBody = z.object({
  presignedUrl: z.string(),
});

export type CreateUploadPayloadUrlResponseBody = z.infer<typeof CreateUploadPayloadUrlResponseBody>;

export const ReplayRunResponse = z.object({
  id: z.string(),
});

export type ReplayRunResponse = z.infer<typeof ReplayRunResponse>;

export const CanceledRunResponse = z.object({
  message: z.string(),
});

export type CanceledRunResponse = z.infer<typeof CanceledRunResponse>;

export const ScheduledTaskPayload = z.object({
  scheduleId: z.string(),
  timestamp: z.date(),
  lastTimestamp: z.date().optional(),
  externalId: z.string().optional(),
  upcoming: z.array(z.date()),
});

export type ScheduledTaskPayload = z.infer<typeof ScheduledTaskPayload>;

export const CreateScheduleOptions = z.object({
  task: z.string(),
  cron: z.string(),
  deduplicationKey: z.string().optional(),
  externalId: z.string().optional(),
});

export type CreateScheduleOptions = z.infer<typeof CreateScheduleOptions>;

export const UpdateScheduleOptions = CreateScheduleOptions;

export type UpdateScheduleOptions = z.infer<typeof UpdateScheduleOptions>;

export const ScheduleObject = z.object({
  id: z.string(),
  task: z.string(),
  active: z.boolean(),
  deduplicationKey: z.string().optional(),
  externalId: z.string().optional(),
  generator: z.object({
    type: z.literal("CRON"),
    expression: z.string(),
    description: z.string(),
  }),
  nextRun: z.coerce.date().optional(),
  environments: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      userName: z.string().optional(),
    })
  ),
});

export type ScheduleObject = z.infer<typeof ScheduleObject>;

export const DeletedScheduleObject = z.object({
  id: z.string(),
});

export type DeletedScheduleObject = z.infer<typeof DeletedScheduleObject>;

export const ListSchedulesResult = z.object({
  data: z.array(ScheduleObject),
  pagination: z.object({
    currentPage: z.number(),
    totalPages: z.number(),
    count: z.number(),
  }),
});

export type ListSchedulesResult = z.infer<typeof ListSchedulesResult>;

export const ListScheduleOptions = z.object({
  page: z.number().optional(),
  perPage: z.number().optional(),
});

export type ListScheduleOptions = z.infer<typeof ListScheduleOptions>;
