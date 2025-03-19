import { coerce, date, z } from "zod";
import { DeserializedJsonSchema } from "../../schemas/json.js";
import {
  FlushedRunMetadata,
  MachinePresetName,
  RunMetadataChangeOperation,
  SerializedError,
  TaskRunError,
} from "./common.js";
import { BackgroundWorkerMetadata } from "./resources.js";
import { QueueOptions } from "./schemas.js";
import { DequeuedMessage, MachineResources, WaitpointStatus } from "./runEngine.js";

export const RunEngineVersion = z.union([z.literal("V1"), z.literal("V2")]);

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
  projectId: z.string(),
});

export type GetProjectEnvResponse = z.infer<typeof GetProjectEnvResponse>;

export const CreateBackgroundWorkerRequestBody = z.object({
  localOnly: z.boolean(),
  metadata: BackgroundWorkerMetadata,
  engine: RunEngineVersion.optional(),
  supportsLazyAttempts: z.boolean().optional(),
});

export type CreateBackgroundWorkerRequestBody = z.infer<typeof CreateBackgroundWorkerRequestBody>;

export const CreateBackgroundWorkerResponse = z.object({
  id: z.string(),
  version: z.string(),
  contentHash: z.string(),
});

export type CreateBackgroundWorkerResponse = z.infer<typeof CreateBackgroundWorkerResponse>;

//an array of 1, 2, or 3 strings
const RunTag = z.string().max(128, "Tags must be less than 128 characters");
export const RunTags = z.union([RunTag, RunTag.array()]);

export type RunTags = z.infer<typeof RunTags>;

export const TriggerTaskRequestBody = z.object({
  payload: z.any(),
  context: z.any(),
  options: z
    .object({
      /** @deprecated engine v1 only */
      dependentAttempt: z.string().optional(),
      /** @deprecated engine v1 only */
      parentAttempt: z.string().optional(),
      /** @deprecated engine v1 only */
      dependentBatch: z.string().optional(),
      /**
       * If triggered in a batch, this is the BatchTaskRun id
       */
      parentBatch: z.string().optional(),
      /**
       * RunEngine v2
       * If triggered inside another run, the parentRunId is the friendly ID of the parent run.
       */
      parentRunId: z.string().optional(),
      /**
       * RunEngine v2
       * Should be `true` if `triggerAndWait` or `batchTriggerAndWait`
       */
      resumeParentOnCompletion: z.boolean().optional(),
      /**
       * Locks the version to the passed value.
       * Automatically set when using `triggerAndWait` or `batchTriggerAndWait`
       */
      lockToVersion: z.string().optional(),

      queue: QueueOptions.optional(),
      concurrencyKey: z.string().optional(),
      delay: z.string().or(z.coerce.date()).optional(),
      idempotencyKey: z.string().optional(),
      idempotencyKeyTTL: z.string().optional(),
      machine: MachinePresetName.optional(),
      maxAttempts: z.number().int().optional(),
      maxDuration: z.number().optional(),
      metadata: z.any(),
      metadataType: z.string().optional(),
      payloadType: z.string().optional(),
      tags: RunTags.optional(),
      test: z.boolean().optional(),
      ttl: z.string().or(z.number().nonnegative().int()).optional(),
      priority: z.number().optional(),
      releaseConcurrency: z.boolean().optional(),
    })
    .optional(),
});

export type TriggerTaskRequestBody = z.infer<typeof TriggerTaskRequestBody>;

export const TriggerTaskResponse = z.object({
  id: z.string(),
  isCached: z.boolean().optional(),
});

export type TriggerTaskResponse = z.infer<typeof TriggerTaskResponse>;

export const BatchTriggerTaskRequestBody = z.object({
  items: TriggerTaskRequestBody.array(),
  dependentAttempt: z.string().optional(),
});

export type BatchTriggerTaskRequestBody = z.infer<typeof BatchTriggerTaskRequestBody>;

export const BatchTriggerTaskItem = z.object({
  task: z.string(),
  payload: z.any(),
  context: z.any(),
  options: z
    .object({
      concurrencyKey: z.string().optional(),
      delay: z.string().or(z.coerce.date()).optional(),
      idempotencyKey: z.string().optional(),
      idempotencyKeyTTL: z.string().optional(),
      lockToVersion: z.string().optional(),
      machine: MachinePresetName.optional(),
      maxAttempts: z.number().int().optional(),
      maxDuration: z.number().optional(),
      metadata: z.any(),
      metadataType: z.string().optional(),
      parentAttempt: z.string().optional(),
      payloadType: z.string().optional(),
      queue: QueueOptions.optional(),
      tags: RunTags.optional(),
      test: z.boolean().optional(),
      ttl: z.string().or(z.number().nonnegative().int()).optional(),
      priority: z.number().optional(),
    })
    .optional(),
});

export type BatchTriggerTaskItem = z.infer<typeof BatchTriggerTaskItem>;

export const BatchTriggerTaskV2RequestBody = z.object({
  items: BatchTriggerTaskItem.array(),
  /** @deprecated engine v1 only */
  dependentAttempt: z.string().optional(),
  /**
   * RunEngine v2
   * If triggered inside another run, the parentRunId is the friendly ID of the parent run.
   */
  parentRunId: z.string().optional(),
  /**
   * RunEngine v2
   * Should be `true` if `triggerAndWait` or `batchTriggerAndWait`
   */
  resumeParentOnCompletion: z.boolean().optional(),
});

export type BatchTriggerTaskV2RequestBody = z.infer<typeof BatchTriggerTaskV2RequestBody>;

export const BatchTriggerTaskV2Response = z.object({
  id: z.string(),
  isCached: z.boolean(),
  idempotencyKey: z.string().optional(),
  runs: z.array(
    z.object({
      id: z.string(),
      taskIdentifier: z.string(),
      isCached: z.boolean(),
      idempotencyKey: z.string().optional(),
    })
  ),
});

export type BatchTriggerTaskV2Response = z.infer<typeof BatchTriggerTaskV2Response>;

export const BatchTriggerTaskV3RequestBody = z.object({
  items: BatchTriggerTaskItem.array(),
  /**
   * RunEngine v2
   * If triggered inside another run, the parentRunId is the friendly ID of the parent run.
   */
  parentRunId: z.string().optional(),
  /**
   * RunEngine v2
   * Should be `true` if `triggerAndWait` or `batchTriggerAndWait`
   */
  resumeParentOnCompletion: z.boolean().optional(),
});

export type BatchTriggerTaskV3RequestBody = z.infer<typeof BatchTriggerTaskV3RequestBody>;

export const BatchTriggerTaskV3Response = z.object({
  id: z.string(),
  runCount: z.number(),
});

export type BatchTriggerTaskV3Response = z.infer<typeof BatchTriggerTaskV3Response>;

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

export const AddTagsRequestBody = z.object({
  tags: RunTags,
});

export type AddTagsRequestBody = z.infer<typeof AddTagsRequestBody>;

export const RescheduleRunRequestBody = z.object({
  delay: z.string().or(z.coerce.date()),
});

export type RescheduleRunRequestBody = z.infer<typeof RescheduleRunRequestBody>;

export const GetEnvironmentVariablesResponseBody = z.object({
  variables: z.record(z.string()),
});

export type GetEnvironmentVariablesResponseBody = z.infer<
  typeof GetEnvironmentVariablesResponseBody
>;

export const StartDeploymentIndexingRequestBody = z.object({
  imageReference: z.string(),
  selfHosted: z.boolean().optional(),
});

export type StartDeploymentIndexingRequestBody = z.infer<typeof StartDeploymentIndexingRequestBody>;

export const StartDeploymentIndexingResponseBody = z.object({
  id: z.string(),
  contentHash: z.string(),
});

export type StartDeploymentIndexingResponseBody = z.infer<
  typeof StartDeploymentIndexingResponseBody
>;

export const FinalizeDeploymentRequestBody = z.object({
  imageReference: z.string(),
  selfHosted: z.boolean().optional(),
  skipRegistryProxy: z.boolean().optional(),
  skipPromotion: z.boolean().optional(),
});

export type FinalizeDeploymentRequestBody = z.infer<typeof FinalizeDeploymentRequestBody>;

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
  registryHost: z.string().optional(),
  selfHosted: z.boolean().optional(),
  namespace: z.string().optional(),
  type: z.enum(["MANAGED", "UNMANAGED", "V1"]).optional(),
});

export type InitializeDeploymentRequestBody = z.infer<typeof InitializeDeploymentRequestBody>;

export const DeploymentErrorData = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
  stderr: z.string().optional(),
});

export type DeploymentErrorData = z.infer<typeof DeploymentErrorData>;

export const FailDeploymentRequestBody = z.object({
  error: DeploymentErrorData,
});

export type FailDeploymentRequestBody = z.infer<typeof FailDeploymentRequestBody>;

export const FailDeploymentResponseBody = z.object({
  id: z.string(),
});

export type FailDeploymentResponseBody = z.infer<typeof FailDeploymentResponseBody>;

export const PromoteDeploymentResponseBody = z.object({
  id: z.string(),
  version: z.string(),
  shortCode: z.string(),
});

export type PromoteDeploymentResponseBody = z.infer<typeof PromoteDeploymentResponseBody>;

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
  imageReference: z.string().nullish(),
  errorData: DeploymentErrorData.nullish(),
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

export const GetLatestDeploymentResponseBody = GetDeploymentResponseBody.omit({
  worker: true,
});
export type GetLatestDeploymentResponseBody = z.infer<typeof GetLatestDeploymentResponseBody>;

export const CreateUploadPayloadUrlResponseBody = z.object({
  presignedUrl: z.string(),
});

export const WorkersListResponseBody = z
  .object({
    type: z.string(),
    name: z.string(),
    description: z.string().nullish(),
    latestVersion: z.string().nullish(),
    lastHeartbeatAt: z.string().nullish(),
    isDefault: z.boolean(),
    updatedAt: z.coerce.date(),
  })
  .array();
export type WorkersListResponseBody = z.infer<typeof WorkersListResponseBody>;

export const WorkersCreateRequestBody = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
});
export type WorkersCreateRequestBody = z.infer<typeof WorkersCreateRequestBody>;

export const WorkersCreateResponseBody = z.object({
  workerGroup: z.object({
    name: z.string(),
    description: z.string().nullish(),
  }),
  token: z.object({
    plaintext: z.string(),
  }),
});
export type WorkersCreateResponseBody = z.infer<typeof WorkersCreateResponseBody>;

export const DevConfigResponseBody = z.object({
  environmentId: z.string(),
  dequeueIntervalWithRun: z.number(),
  dequeueIntervalWithoutRun: z.number(),
  maxConcurrentRuns: z.number(),
});
export type DevConfigResponseBody = z.infer<typeof DevConfigResponseBody>;

export const DevDequeueRequestBody = z.object({
  currentWorker: z.string(),
  oldWorkers: z.string().array(),
  maxResources: MachineResources.optional(),
});
export type DevDequeueRequestBody = z.infer<typeof DevDequeueRequestBody>;

export const DevDequeueResponseBody = z.object({
  dequeuedMessages: DequeuedMessage.array(),
});
export type DevDequeueResponseBody = z.infer<typeof DevDequeueResponseBody>;

export type CreateUploadPayloadUrlResponseBody = z.infer<typeof CreateUploadPayloadUrlResponseBody>;

export const ReplayRunResponse = z.object({
  id: z.string(),
});

export type ReplayRunResponse = z.infer<typeof ReplayRunResponse>;

export const CanceledRunResponse = z.object({
  id: z.string(),
});

export type CanceledRunResponse = z.infer<typeof CanceledRunResponse>;

export const ScheduleType = z.union([z.literal("DECLARATIVE"), z.literal("IMPERATIVE")]);

export const ScheduledTaskPayload = z.object({
  /** The schedule id associated with this run (you can have many schedules for the same task).
    You can use this to remove the schedule, update it, etc */
  scheduleId: z.string(),
  /** The type of schedule – `"DECLARATIVE"` or `"IMPERATIVE"`.
   *
   * **DECLARATIVE** – defined inline on your `schedules.task` using the `cron` property. They can only be created, updated or deleted by modifying the `cron` property on your task.
   *
   * **IMPERATIVE** – created using the `schedules.create` functions or in the dashboard.
   */
  type: ScheduleType,
  /** When the task was scheduled to run.
   * Note this will be slightly different from `new Date()` because it takes a few ms to run the task.
   *
   * This date is UTC. To output it as a string with a timezone you would do this:
   * ```ts
   * const formatted = payload.timestamp.toLocaleString("en-US", {
        timeZone: payload.timezone,
    });
    ```  */
  timestamp: z.date(),
  /** When the task was last run (it has been).
    This can be undefined if it's never been run. This date is UTC. */
  lastTimestamp: z.date().optional(),
  /** You can optionally provide an external id when creating the schedule.
    Usually you would use a userId or some other unique identifier.
    This defaults to undefined if you didn't provide one. */
  externalId: z.string().optional(),
  /** The IANA timezone the schedule is set to. The default is UTC.
   * You can see the full list of supported timezones here: https://cloud.trigger.dev/timezones
   */
  timezone: z.string(),
  /** The next 5 dates this task is scheduled to run */
  upcoming: z.array(z.date()),
});

export type ScheduledTaskPayload = z.infer<typeof ScheduledTaskPayload>;

export const CreateScheduleOptions = z.object({
  /** The id of the task you want to attach to. */
  task: z.string(),
  /**  The schedule in CRON format.
   *
   * ```txt
*    *    *    *    *    *
┬    ┬    ┬    ┬    ┬
│    │    │    │    |
│    │    │    │    └ day of week (0 - 7, 1L - 7L) (0 or 7 is Sun)
│    │    │    └───── month (1 - 12)
│    │    └────────── day of month (1 - 31, L)
│    └─────────────── hour (0 - 23)
└──────────────────── minute (0 - 59)
   * ```

"L" means the last. In the "day of week" field, 1L means the last Monday of the month. In the day of month field, L means the last day of the month.

   */
  cron: z.string(),
  /** You can only create one schedule with this key. If you use it twice, the second call will update the schedule.
   *
   * This is required to prevent you from creating duplicate schedules. */
  deduplicationKey: z.string(),
  /** Optionally, you can specify your own IDs (like a user ID) and then use it inside the run function of your task.
   *
   * This allows you to have per-user CRON tasks.
   */
  externalId: z.string().optional(),
  /** Optionally, you can specify a timezone in the IANA format. If unset it will use UTC.
   * If specified then the CRON will be evaluated in that timezone and will respect daylight savings.
   *
   * If you set the CRON to `0 0 * * *` and the timezone to `America/New_York` then the task will run at midnight in New York time, no matter whether it's daylight savings or not.
   *
   * You can see the full list of supported timezones here: https://cloud.trigger.dev/timezones
   *
   * @example "America/New_York", "Europe/London", "Asia/Tokyo", "Africa/Cairo"
   *
   */
  timezone: z.string().optional(),
});

export type CreateScheduleOptions = z.infer<typeof CreateScheduleOptions>;

export const UpdateScheduleOptions = CreateScheduleOptions.omit({ deduplicationKey: true });

export type UpdateScheduleOptions = z.infer<typeof UpdateScheduleOptions>;

export const ScheduleGenerator = z.object({
  type: z.literal("CRON"),
  expression: z.string(),
  description: z.string(),
});

export type ScheduleGenerator = z.infer<typeof ScheduleGenerator>;

export const ScheduleObject = z.object({
  id: z.string(),
  type: ScheduleType,
  task: z.string(),
  active: z.boolean(),
  deduplicationKey: z.string().nullish(),
  externalId: z.string().nullish(),
  generator: ScheduleGenerator,
  timezone: z.string(),
  nextRun: z.coerce.date().nullish(),
  environments: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      userName: z.string().nullish(),
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

export const TimezonesResult = z.object({
  timezones: z.array(z.string()),
});

export type TimezonesResult = z.infer<typeof TimezonesResult>;

export const RunStatus = z.enum([
  /// Task hasn't been deployed yet but is waiting to be executed
  "WAITING_FOR_DEPLOY",
  /// Task is waiting to be executed by a worker
  "QUEUED",
  /// Task is currently being executed by a worker
  "EXECUTING",
  /// Task has failed and is waiting to be retried
  "REATTEMPTING",
  /// Task has been paused by the system, and will be resumed by the system
  "FROZEN",
  /// Task has been completed successfully
  "COMPLETED",
  /// Task has been canceled by the user
  "CANCELED",
  /// Task has been completed with errors
  "FAILED",
  /// Task has crashed and won't be retried, most likely the worker ran out of resources, e.g. memory or storage
  "CRASHED",
  /// Task was interrupted during execution, mostly this happens in development environments
  "INTERRUPTED",
  /// Task has failed to complete, due to an error in the system
  "SYSTEM_FAILURE",
  /// Task has been scheduled to run at a specific time
  "DELAYED",
  /// Task has expired and won't be executed
  "EXPIRED",
  /// Task has reached it's maxDuration and has been stopped
  "TIMED_OUT",
]);

export type RunStatus = z.infer<typeof RunStatus>;

export const AttemptStatus = z.enum([
  "PENDING",
  "EXECUTING",
  "PAUSED",
  "COMPLETED",
  "FAILED",
  "CANCELED",
]);

export type AttemptStatus = z.infer<typeof AttemptStatus>;

export const RunEnvironmentDetails = z.object({
  id: z.string(),
  name: z.string(),
  user: z.string().optional(),
});

export type RunEnvironmentDetails = z.infer<typeof RunEnvironmentDetails>;

export const RunScheduleDetails = z.object({
  id: z.string(),
  externalId: z.string().optional(),
  deduplicationKey: z.string().optional(),
  generator: ScheduleGenerator,
});

export type RunScheduleDetails = z.infer<typeof RunScheduleDetails>;

export const TriggerFunction = z.enum([
  "triggerAndWait",
  "trigger",
  "batchTriggerAndWait",
  "batchTrigger",
]);

export type TriggerFunction = z.infer<typeof TriggerFunction>;

const CommonRunFields = {
  id: z.string(),
  status: RunStatus,
  taskIdentifier: z.string(),
  idempotencyKey: z.string().optional(),
  version: z.string().optional(),
  isQueued: z.boolean(),
  isExecuting: z.boolean(),
  isCompleted: z.boolean(),
  isSuccess: z.boolean(),
  isFailed: z.boolean(),
  isCancelled: z.boolean(),
  isTest: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  startedAt: z.coerce.date().optional(),
  finishedAt: z.coerce.date().optional(),
  delayedUntil: z.coerce.date().optional(),
  ttl: z.string().optional(),
  expiredAt: z.coerce.date().optional(),
  tags: z.string().array(),
  costInCents: z.number(),
  baseCostInCents: z.number(),
  durationMs: z.number(),
  metadata: z.record(z.any()).optional(),
};

const RetrieveRunCommandFields = {
  ...CommonRunFields,
  depth: z.number(),
  triggerFunction: z.enum(["triggerAndWait", "trigger", "batchTriggerAndWait", "batchTrigger"]),
  batchId: z.string().optional(),
};

export const RelatedRunDetails = z.object(RetrieveRunCommandFields);

export const RetrieveRunResponse = z.object({
  ...RetrieveRunCommandFields,
  payload: z.any().optional(),
  payloadPresignedUrl: z.string().optional(),
  output: z.any().optional(),
  outputPresignedUrl: z.string().optional(),
  error: SerializedError.optional(),
  schedule: RunScheduleDetails.optional(),
  relatedRuns: z.object({
    root: RelatedRunDetails.optional(),
    parent: RelatedRunDetails.optional(),
    children: z.array(RelatedRunDetails).optional(),
  }),
  attempts: z.array(
    z
      .object({
        id: z.string(),
        status: AttemptStatus,
        createdAt: z.coerce.date(),
        updatedAt: z.coerce.date(),
        startedAt: z.coerce.date().optional(),
        completedAt: z.coerce.date().optional(),
        error: SerializedError.optional(),
      })
      .optional()
  ),
  attemptCount: z.number().default(0),
});

export type RetrieveRunResponse = z.infer<typeof RetrieveRunResponse>;

export const ListRunResponseItem = z.object({
  ...CommonRunFields,
  env: RunEnvironmentDetails,
});

export type ListRunResponseItem = z.infer<typeof ListRunResponseItem>;

export const ListRunResponse = z.object({
  data: z.array(ListRunResponseItem),
  pagination: z.object({
    next: z.string().optional(),
    previous: z.string().optional(),
  }),
});

export type ListRunResponse = z.infer<typeof ListRunResponse>;

export const CreateEnvironmentVariableRequestBody = z.object({
  name: z.string(),
  value: z.string(),
});

export type CreateEnvironmentVariableRequestBody = z.infer<
  typeof CreateEnvironmentVariableRequestBody
>;

export const UpdateEnvironmentVariableRequestBody = z.object({
  value: z.string(),
});

export type UpdateEnvironmentVariableRequestBody = z.infer<
  typeof UpdateEnvironmentVariableRequestBody
>;

export const ImportEnvironmentVariablesRequestBody = z.object({
  variables: z.record(z.string()),
  override: z.boolean().optional(),
});

export type ImportEnvironmentVariablesRequestBody = z.infer<
  typeof ImportEnvironmentVariablesRequestBody
>;

export const EnvironmentVariableResponseBody = z.object({
  success: z.boolean(),
});

export type EnvironmentVariableResponseBody = z.infer<typeof EnvironmentVariableResponseBody>;

export const EnvironmentVariableValue = z.object({
  value: z.string(),
});

export type EnvironmentVariableValue = z.infer<typeof EnvironmentVariableValue>;

export const EnvironmentVariable = z.object({
  name: z.string(),
  value: z.string(),
});

export const EnvironmentVariables = z.array(EnvironmentVariable);

export type EnvironmentVariables = z.infer<typeof EnvironmentVariables>;

export const UpdateMetadataRequestBody = FlushedRunMetadata;

export type UpdateMetadataRequestBody = z.infer<typeof UpdateMetadataRequestBody>;

export const UpdateMetadataResponseBody = z.object({
  metadata: z.record(DeserializedJsonSchema),
});

export type UpdateMetadataResponseBody = z.infer<typeof UpdateMetadataResponseBody>;

const RawShapeDate = z
  .string()
  .transform((val) => `${val}Z`)
  .pipe(z.coerce.date());

const RawOptionalShapeDate = z
  .string()
  .nullish()
  .transform((val) => (val ? new Date(`${val}Z`) : val));

export const SubscribeRunRawShape = z.object({
  id: z.string(),
  idempotencyKey: z.string().nullish(),
  createdAt: RawShapeDate,
  updatedAt: RawShapeDate,
  startedAt: RawOptionalShapeDate,
  delayUntil: RawOptionalShapeDate,
  queuedAt: RawOptionalShapeDate,
  expiredAt: RawOptionalShapeDate,
  completedAt: RawOptionalShapeDate,
  taskIdentifier: z.string(),
  friendlyId: z.string(),
  number: z.number(),
  isTest: z.boolean(),
  status: z.string(),
  usageDurationMs: z.number(),
  costInCents: z.number(),
  baseCostInCents: z.number(),
  ttl: z.string().nullish(),
  payload: z.string().nullish(),
  payloadType: z.string().nullish(),
  metadata: z.string().nullish(),
  metadataType: z.string().nullish(),
  output: z.string().nullish(),
  outputType: z.string().nullish(),
  runTags: z.array(z.string()).nullish().default([]),
  error: TaskRunError.nullish(),
});

export type SubscribeRunRawShape = z.infer<typeof SubscribeRunRawShape>;

export const BatchStatus = z.enum(["PENDING", "COMPLETED"]);

export type BatchStatus = z.infer<typeof BatchStatus>;

export const RetrieveBatchResponse = z.object({
  id: z.string(),
  status: BatchStatus,
  idempotencyKey: z.string().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  runCount: z.number(),
  runs: z.array(z.string()),
});

export type RetrieveBatchResponse = z.infer<typeof RetrieveBatchResponse>;

export const RetrieveBatchV2Response = z.object({
  id: z.string(),
  status: BatchStatus,
  idempotencyKey: z.string().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  runCount: z.number(),
  runs: z.array(z.string()),
});

export type RetrieveBatchV2Response = z.infer<typeof RetrieveBatchV2Response>;

export const SubscribeRealtimeStreamChunkRawShape = z.object({
  id: z.string(),
  runId: z.string(),
  sequence: z.number(),
  key: z.string(),
  value: z.string(),
  createdAt: z.coerce.date(),
});

export type SubscribeRealtimeStreamChunkRawShape = z.infer<
  typeof SubscribeRealtimeStreamChunkRawShape
>;

export const TimePeriod = z.string().or(z.coerce.date());
export type TimePeriod = z.infer<typeof TimePeriod>;

export const CreateWaitpointTokenRequestBody = z.object({
  /**
   * An optional idempotency key for the waitpoint.
   * If you use the same key twice (and the key hasn't expired), you will get the original waitpoint back.
   *
   * Note: This waitpoint may already be complete, in which case when you wait for it, it will immediately continue.
   */
  idempotencyKey: z.string().optional(),
  /**
   * When set, this means the passed in idempotency key will expire after this time.
   * This means after that time if you pass the same idempotency key again, you will get a new waitpoint.
   */
  idempotencyKeyTTL: z.string().optional(),
  /** The resume token will timeout after this time.
   * If you are waiting for the token in a run, the token will return a result where `ok` is false.
   *
   * You can pass a `Date` object, or a string in this format: "30s", "1m", "2h", "3d", "4w".
   */
  timeout: TimePeriod.optional(),
});
export type CreateWaitpointTokenRequestBody = z.infer<typeof CreateWaitpointTokenRequestBody>;

export const CreateWaitpointTokenResponseBody = z.object({
  id: z.string(),
  isCached: z.boolean(),
});
export type CreateWaitpointTokenResponseBody = z.infer<typeof CreateWaitpointTokenResponseBody>;

export const CompleteWaitpointTokenRequestBody = z.object({
  data: z.any().nullish(),
});
export type CompleteWaitpointTokenRequestBody = z.infer<typeof CompleteWaitpointTokenRequestBody>;

export const CompleteWaitpointTokenResponseBody = z.object({
  success: z.literal(true),
});
export type CompleteWaitpointTokenResponseBody = z.infer<typeof CompleteWaitpointTokenResponseBody>;

export const WaitForWaitpointTokenResponseBody = z.object({
  success: z.boolean(),
});
export type WaitForWaitpointTokenResponseBody = z.infer<typeof WaitForWaitpointTokenResponseBody>;

export const WaitForDurationRequestBody = z.object({
  /**
   * An optional idempotency key for the waitpoint.
   * If you use the same key twice (and the key hasn't expired), you will get the original waitpoint back.
   *
   * Note: This waitpoint may already be complete, in which case when you wait for it, it will immediately continue.
   */
  idempotencyKey: z.string().optional(),
  /**
   * When set, this means the passed in idempotency key will expire after this time.
   * This means after that time if you pass the same idempotency key again, you will get a new waitpoint.
   */
  idempotencyKeyTTL: z.string().optional(),

  releaseConcurrency: z.boolean().optional(),

  date: z.coerce.date(),
});
export type WaitForDurationRequestBody = z.infer<typeof WaitForDurationRequestBody>;

export const WaitForDurationResponseBody = z.object({
  /**
      If you pass an idempotencyKey, you may actually not need to wait.
      Use this date to determine when to continue.
  */
  waitUntil: z.coerce.date(),
  waitpoint: z.object({
    id: z.string(),
  }),
});
export type WaitForDurationResponseBody = z.infer<typeof WaitForDurationResponseBody>;

const WAITPOINT_TIMEOUT_ERROR_CODE = "TRIGGER_WAITPOINT_TIMEOUT";

export function isWaitpointOutputTimeout(output: string): boolean {
  try {
    const json = JSON.parse(output);
    return json.code === WAITPOINT_TIMEOUT_ERROR_CODE;
  } catch (e) {
    return false;
  }
}

export function timeoutError(timeout: Date) {
  return {
    code: WAITPOINT_TIMEOUT_ERROR_CODE,
    message: `Waitpoint timed out at ${timeout.toISOString()}`,
  };
}
