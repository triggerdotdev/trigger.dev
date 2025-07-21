import { z } from "zod";
import { VERSION } from "../../version.js";
import { generateJWT } from "../jwt.js";
import {
  AddTagsRequestBody,
  BatchTaskRunExecutionResult,
  BatchTriggerTaskV3RequestBody,
  BatchTriggerTaskV3Response,
  CanceledRunResponse,
  CompleteWaitpointTokenRequestBody,
  CompleteWaitpointTokenResponseBody,
  CreateEnvironmentVariableRequestBody,
  CreateScheduleOptions,
  CreateUploadPayloadUrlResponseBody,
  CreateWaitpointTokenRequestBody,
  CreateWaitpointTokenResponseBody,
  DeletedScheduleObject,
  EnvironmentVariableResponseBody,
  EnvironmentVariableWithSecret,
  ListQueueOptions,
  ListRunResponseItem,
  ListScheduleOptions,
  QueueItem,
  QueueTypeName,
  ReplayRunResponse,
  RescheduleRunRequestBody,
  RetrieveBatchV2Response,
  RetrieveQueueParam,
  RetrieveRunResponse,
  ScheduleObject,
  TaskRunExecutionResult,
  TriggerTaskRequestBody,
  TriggerTaskResponse,
  UpdateEnvironmentVariableRequestBody,
  UpdateMetadataRequestBody,
  UpdateMetadataResponseBody,
  UpdateScheduleOptions,
  WaitForDurationRequestBody,
  WaitForDurationResponseBody,
  WaitForWaitpointTokenResponseBody,
  WaitpointRetrieveTokenResponse,
  WaitpointTokenItem,
} from "../schemas/index.js";
import { AsyncIterableStream } from "../streams/asyncIterableStream.js";
import { taskContext } from "../task-context-api.js";
import { AnyRunTypes, TriggerJwtOptions } from "../types/tasks.js";
import { Prettify } from "../types/utils.js";
import {
  AnyZodFetchOptions,
  ApiPromise,
  ApiRequestOptions,
  CursorPagePromise,
  ZodFetchOptions,
  isRequestOptions,
  zodfetch,
  zodfetchCursorPage,
  zodfetchOffsetLimitPage,
} from "./core.js";
import { ApiError } from "./errors.js";
import {
  AnyRealtimeRun,
  AnyRunShape,
  RealtimeRun,
  RunShape,
  RunStreamCallback,
  RunSubscription,
  SSEStreamSubscriptionFactory,
  TaskRunShape,
  runShapeStream,
  RealtimeRunSkipColumns,
} from "./runStream.js";
import {
  CreateEnvironmentVariableParams,
  ImportEnvironmentVariablesParams,
  ListProjectRunsQueryParams,
  ListRunsQueryParams,
  ListWaitpointTokensQueryParams,
  SubscribeToRunsQueryParams,
  UpdateEnvironmentVariableParams,
} from "./types.js";
import { API_VERSION, API_VERSION_HEADER_NAME } from "./version.js";

export type CreateWaitpointTokenResponse = Prettify<
  CreateWaitpointTokenResponseBody & {
    publicAccessToken: string;
  }
>;

export type {
  CreateEnvironmentVariableParams,
  ImportEnvironmentVariablesParams,
  SubscribeToRunsQueryParams,
  UpdateEnvironmentVariableParams,
  RealtimeRunSkipColumns,
};

export type ClientTriggerOptions = {
  spanParentAsLink?: boolean;
};

export type ClientBatchTriggerOptions = ClientTriggerOptions & {
  processingStrategy?: "parallel" | "sequential";
};

export type TriggerRequestOptions = ZodFetchOptions & {
  publicAccessToken?: TriggerJwtOptions;
};

export type TriggerApiRequestOptions = ApiRequestOptions & {
  publicAccessToken?: TriggerJwtOptions;
};

const DEFAULT_ZOD_FETCH_OPTIONS: ZodFetchOptions = {
  retry: {
    maxAttempts: 5,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 30_000,
    factor: 1.6,
    randomize: false,
  },
};

export { isRequestOptions };
export type {
  AnyRealtimeRun,
  AnyRunShape,
  ApiRequestOptions,
  RealtimeRun,
  RunShape,
  RunStreamCallback,
  RunSubscription,
  TaskRunShape,
};

export * from "./getBranch.js";

/**
 * Trigger.dev v3 API client
 */
export class ApiClient {
  public readonly baseUrl: string;
  public readonly accessToken: string;
  public readonly previewBranch?: string;
  private readonly defaultRequestOptions: ZodFetchOptions;

  constructor(
    baseUrl: string,
    accessToken: string,
    previewBranch?: string,
    requestOptions: ApiRequestOptions = {}
  ) {
    this.accessToken = accessToken;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.previewBranch = previewBranch;
    this.defaultRequestOptions = mergeRequestOptions(DEFAULT_ZOD_FETCH_OPTIONS, requestOptions);
  }

  get fetchClient(): typeof fetch {
    const headers = this.#getHeaders(false);

    const fetchClient: typeof fetch = (input, requestInit) => {
      const $requestInit: RequestInit = {
        ...requestInit,
        headers: {
          ...requestInit?.headers,
          ...headers,
        },
      };

      return fetch(input, $requestInit);
    };

    return fetchClient;
  }

  getHeaders() {
    return this.#getHeaders(false);
  }

  async getRunResult(
    runId: string,
    requestOptions?: ZodFetchOptions
  ): Promise<TaskRunExecutionResult | undefined> {
    try {
      return await zodfetch(
        TaskRunExecutionResult,
        `${this.baseUrl}/api/v1/runs/${runId}/result`,
        {
          method: "GET",
          headers: this.#getHeaders(false),
        },
        mergeRequestOptions(this.defaultRequestOptions, requestOptions)
      );
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 404) {
          return undefined;
        }
      }

      throw error;
    }
  }

  async getBatchResults(
    batchId: string,
    requestOptions?: ZodFetchOptions
  ): Promise<BatchTaskRunExecutionResult | undefined> {
    return await zodfetch(
      BatchTaskRunExecutionResult,
      `${this.baseUrl}/api/v1/batches/${batchId}/results`,
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  triggerTask(
    taskId: string,
    body: TriggerTaskRequestBody,
    clientOptions?: ClientTriggerOptions,
    requestOptions?: TriggerRequestOptions
  ) {
    const encodedTaskId = encodeURIComponent(taskId);

    return zodfetch(
      TriggerTaskResponse,
      `${this.baseUrl}/api/v1/tasks/${encodedTaskId}/trigger`,
      {
        method: "POST",
        headers: this.#getHeaders(clientOptions?.spanParentAsLink ?? false),
        body: JSON.stringify(body),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    )
      .withResponse()
      .then(async ({ data, response }) => {
        const jwtHeader = response.headers.get("x-trigger-jwt");

        if (typeof jwtHeader === "string") {
          return {
            ...data,
            publicAccessToken: jwtHeader,
          };
        }

        const claimsHeader = response.headers.get("x-trigger-jwt-claims");
        const claims = claimsHeader ? JSON.parse(claimsHeader) : undefined;

        const jwt = await generateJWT({
          secretKey: this.accessToken,
          payload: {
            ...claims,
            scopes: [`read:runs:${data.id}`],
          },
          expirationTime: requestOptions?.publicAccessToken?.expirationTime ?? "1h",
        });

        return {
          ...data,
          publicAccessToken: jwt,
        };
      });
  }

  batchTriggerV3(
    body: BatchTriggerTaskV3RequestBody,
    clientOptions?: ClientBatchTriggerOptions,
    requestOptions?: TriggerRequestOptions
  ) {
    return zodfetch(
      BatchTriggerTaskV3Response,
      `${this.baseUrl}/api/v2/tasks/batch`,
      {
        method: "POST",
        headers: this.#getHeaders(clientOptions?.spanParentAsLink ?? false, {
          "batch-processing-strategy": clientOptions?.processingStrategy,
        }),
        body: JSON.stringify(body),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    )
      .withResponse()
      .then(async ({ data, response }) => {
        const claimsHeader = response.headers.get("x-trigger-jwt-claims");
        const claims = claimsHeader ? JSON.parse(claimsHeader) : undefined;

        const jwt = await generateJWT({
          secretKey: this.accessToken,
          payload: {
            ...claims,
            scopes: [`read:batch:${data.id}`],
          },
          expirationTime: requestOptions?.publicAccessToken?.expirationTime ?? "1h",
        });

        return {
          ...data,
          publicAccessToken: jwt,
        };
      });
  }

  createUploadPayloadUrl(filename: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      CreateUploadPayloadUrlResponseBody,
      `${this.baseUrl}/api/v1/packets/${filename}`,
      {
        method: "PUT",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  getPayloadUrl(filename: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      CreateUploadPayloadUrlResponseBody,
      `${this.baseUrl}/api/v1/packets/${filename}`,
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  retrieveRun(runId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      RetrieveRunResponse,
      `${this.baseUrl}/api/v3/runs/${runId}`,
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  listRuns(
    query?: ListRunsQueryParams,
    requestOptions?: ZodFetchOptions
  ): CursorPagePromise<typeof ListRunResponseItem> {
    const searchParams = createSearchQueryForListRuns(query);

    return zodfetchCursorPage(
      ListRunResponseItem,
      `${this.baseUrl}/api/v1/runs`,
      {
        query: searchParams,
        limit: query?.limit,
        after: query?.after,
        before: query?.before,
      },
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  listProjectRuns(
    projectRef: string,
    query?: ListProjectRunsQueryParams,
    requestOptions?: ZodFetchOptions
  ): CursorPagePromise<typeof ListRunResponseItem> {
    const searchParams = createSearchQueryForListRuns(query);

    if (query?.env) {
      searchParams.append(
        "filter[env]",
        Array.isArray(query.env) ? query.env.join(",") : query.env
      );
    }

    return zodfetchCursorPage(
      ListRunResponseItem,
      `${this.baseUrl}/api/v1/projects/${projectRef}/runs`,
      {
        query: searchParams,
        limit: query?.limit,
        after: query?.after,
        before: query?.before,
      },
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  replayRun(runId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      ReplayRunResponse,
      `${this.baseUrl}/api/v1/runs/${runId}/replay`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  cancelRun(runId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      CanceledRunResponse,
      `${this.baseUrl}/api/v2/runs/${runId}/cancel`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  rescheduleRun(runId: string, body: RescheduleRunRequestBody, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      RetrieveRunResponse,
      `${this.baseUrl}/api/v1/runs/${runId}/reschedule`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
        body: JSON.stringify(body),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  listRunEvents(runId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      z.any(), // TODO: define a proper schema for this
      `${this.baseUrl}/api/v1/runs/${runId}/events`,
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  addTags(runId: string, body: AddTagsRequestBody, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      z.object({ message: z.string() }),
      `${this.baseUrl}/api/v1/runs/${runId}/tags`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
        body: JSON.stringify(body),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  createSchedule(options: CreateScheduleOptions, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      ScheduleObject,
      `${this.baseUrl}/api/v1/schedules`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
        body: JSON.stringify(options),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  listSchedules(options?: ListScheduleOptions, requestOptions?: ZodFetchOptions) {
    const searchParams = new URLSearchParams();

    if (options?.page) {
      searchParams.append("page", options.page.toString());
    }

    if (options?.perPage) {
      searchParams.append("perPage", options.perPage.toString());
    }

    return zodfetchOffsetLimitPage(
      ScheduleObject,
      `${this.baseUrl}/api/v1/schedules`,
      {
        page: options?.page,
        limit: options?.perPage,
      },
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  retrieveSchedule(scheduleId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      ScheduleObject,
      `${this.baseUrl}/api/v1/schedules/${scheduleId}`,
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  updateSchedule(
    scheduleId: string,
    options: UpdateScheduleOptions,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      ScheduleObject,
      `${this.baseUrl}/api/v1/schedules/${scheduleId}`,
      {
        method: "PUT",
        headers: this.#getHeaders(false),
        body: JSON.stringify(options),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  deactivateSchedule(scheduleId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      ScheduleObject,
      `${this.baseUrl}/api/v1/schedules/${scheduleId}/deactivate`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  activateSchedule(scheduleId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      ScheduleObject,
      `${this.baseUrl}/api/v1/schedules/${scheduleId}/activate`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  deleteSchedule(scheduleId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      DeletedScheduleObject,
      `${this.baseUrl}/api/v1/schedules/${scheduleId}`,
      {
        method: "DELETE",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  listEnvVars(projectRef: string, slug: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      z.array(EnvironmentVariableWithSecret),
      `${this.baseUrl}/api/v1/projects/${projectRef}/envvars/${slug}`,
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  importEnvVars(
    projectRef: string,
    slug: string,
    body: ImportEnvironmentVariablesParams,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      EnvironmentVariableResponseBody,
      `${this.baseUrl}/api/v1/projects/${projectRef}/envvars/${slug}/import`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
        body: JSON.stringify(body),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  retrieveEnvVar(projectRef: string, slug: string, key: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      EnvironmentVariableWithSecret,
      `${this.baseUrl}/api/v1/projects/${projectRef}/envvars/${slug}/${key}`,
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  createEnvVar(
    projectRef: string,
    slug: string,
    body: CreateEnvironmentVariableRequestBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      EnvironmentVariableResponseBody,
      `${this.baseUrl}/api/v1/projects/${projectRef}/envvars/${slug}`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
        body: JSON.stringify(body),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  updateEnvVar(
    projectRef: string,
    slug: string,
    key: string,
    body: UpdateEnvironmentVariableRequestBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      EnvironmentVariableResponseBody,
      `${this.baseUrl}/api/v1/projects/${projectRef}/envvars/${slug}/${key}`,
      {
        method: "PUT",
        headers: this.#getHeaders(false),
        body: JSON.stringify(body),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  deleteEnvVar(projectRef: string, slug: string, key: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      EnvironmentVariableResponseBody,
      `${this.baseUrl}/api/v1/projects/${projectRef}/envvars/${slug}/${key}`,
      {
        method: "DELETE",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  updateRunMetadata(
    runId: string,
    body: UpdateMetadataRequestBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      UpdateMetadataResponseBody,
      `${this.baseUrl}/api/v1/runs/${runId}/metadata`,
      {
        method: "PUT",
        headers: this.#getHeaders(false),
        body: JSON.stringify(body),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  getRunMetadata(runId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      UpdateMetadataResponseBody,
      `${this.baseUrl}/api/v1/runs/${runId}/metadata`,
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  createWaitpointToken(options: CreateWaitpointTokenRequestBody, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      CreateWaitpointTokenResponseBody,
      `${this.baseUrl}/api/v1/waitpoints/tokens`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
        body: JSON.stringify(options),
      },
      {
        ...mergeRequestOptions(this.defaultRequestOptions, requestOptions),
        prepareData: async (data, response) => {
          const jwtHeader = response.headers.get("x-trigger-jwt");

          if (typeof jwtHeader === "string") {
            return {
              ...data,
              publicAccessToken: jwtHeader,
            };
          }

          const claimsHeader = response.headers.get("x-trigger-jwt-claims");
          const claims = claimsHeader ? JSON.parse(claimsHeader) : undefined;

          const jwt = await generateJWT({
            secretKey: this.accessToken,
            payload: {
              ...claims,
              scopes: [`write:waitpoints:${data.id}`],
            },
            expirationTime: "24h",
          });

          return {
            ...data,
            publicAccessToken: jwt,
          };
        },
      }
    ) as ApiPromise<CreateWaitpointTokenResponse>;
  }

  listWaitpointTokens(
    params?: ListWaitpointTokensQueryParams,
    requestOptions?: ZodFetchOptions
  ): CursorPagePromise<typeof WaitpointTokenItem> {
    const searchParams = createSearchQueryForListWaitpointTokens(params);

    return zodfetchCursorPage(
      WaitpointTokenItem,
      `${this.baseUrl}/api/v1/waitpoints/tokens`,
      {
        query: searchParams,
        limit: params?.limit,
        after: params?.after,
        before: params?.before,
      },
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  retrieveWaitpointToken(friendlyId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      WaitpointRetrieveTokenResponse,
      `${this.baseUrl}/api/v1/waitpoints/tokens/${friendlyId}`,
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  completeWaitpointToken(
    friendlyId: string,
    options: CompleteWaitpointTokenRequestBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      CompleteWaitpointTokenResponseBody,
      `${this.baseUrl}/api/v1/waitpoints/tokens/${friendlyId}/complete`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
        body: JSON.stringify(options),
      },
      {
        ...mergeRequestOptions(this.defaultRequestOptions, requestOptions),
      }
    );
  }

  waitForWaitpointToken(
    {
      runFriendlyId,
      waitpointFriendlyId,
    }: {
      runFriendlyId: string;
      waitpointFriendlyId: string;
    },
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      WaitForWaitpointTokenResponseBody,
      `${this.baseUrl}/engine/v1/runs/${runFriendlyId}/waitpoints/tokens/${waitpointFriendlyId}/wait`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  async waitForDuration(
    runId: string,
    body: WaitForDurationRequestBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      WaitForDurationResponseBody,
      `${this.baseUrl}/engine/v1/runs/${runId}/wait/duration`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
        body: JSON.stringify(body),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  listQueues(options?: ListQueueOptions, requestOptions?: ZodFetchOptions) {
    const searchParams = new URLSearchParams();

    if (options?.page) {
      searchParams.append("page", options.page.toString());
    }

    if (options?.perPage) {
      searchParams.append("perPage", options.perPage.toString());
    }

    return zodfetchOffsetLimitPage(
      QueueItem,
      `${this.baseUrl}/api/v1/queues`,
      {
        page: options?.page,
        limit: options?.perPage,
      },
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  retrieveQueue(queue: RetrieveQueueParam, requestOptions?: ZodFetchOptions) {
    const type = typeof queue === "string" ? "id" : queue.type;
    const value = typeof queue === "string" ? queue : queue.name;

    // Explicitly encode slashes before encoding the rest of the string
    const encodedValue = encodeURIComponent(value.replace(/\//g, "%2F"));

    return zodfetch(
      QueueItem,
      `${this.baseUrl}/api/v1/queues/${encodedValue}?type=${type}`,
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  pauseQueue(
    queue: RetrieveQueueParam,
    action: "pause" | "resume",
    requestOptions?: ZodFetchOptions
  ) {
    const type = typeof queue === "string" ? "id" : queue.type;
    const value = typeof queue === "string" ? queue : queue.name;

    // Explicitly encode slashes before encoding the rest of the string
    const encodedValue = encodeURIComponent(value.replace(/\//g, "%2F"));

    return zodfetch(
      QueueItem,
      `${this.baseUrl}/api/v1/queues/${encodedValue}/pause`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
        body: JSON.stringify({
          type,
          action,
        }),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  subscribeToRun<TRunTypes extends AnyRunTypes>(
    runId: string,
    options?: {
      signal?: AbortSignal;
      closeOnComplete?: boolean;
      onFetchError?: (error: Error) => void;
      skipColumns?: string[];
    }
  ) {
    const queryParams = new URLSearchParams();

    if (options?.skipColumns) {
      queryParams.append("skipColumns", options.skipColumns.join(","));
    }

    return runShapeStream<TRunTypes>(
      `${this.baseUrl}/realtime/v1/runs/${runId}${queryParams ? `?${queryParams}` : ""}`,
      {
        closeOnComplete:
          typeof options?.closeOnComplete === "boolean" ? options.closeOnComplete : true,
        headers: this.#getRealtimeHeaders(),
        client: this,
        signal: options?.signal,
        onFetchError: options?.onFetchError,
      }
    );
  }

  subscribeToRunsWithTag<TRunTypes extends AnyRunTypes>(
    tag: string | string[],
    filters?: { createdAt?: string; skipColumns?: string[] },
    options?: { signal?: AbortSignal; onFetchError?: (error: Error) => void }
  ) {
    const searchParams = createSearchQueryForSubscribeToRuns({
      tags: tag,
      ...(filters ? { createdAt: filters.createdAt } : {}),
      ...(filters?.skipColumns ? { skipColumns: filters.skipColumns } : {}),
    });

    return runShapeStream<TRunTypes>(
      `${this.baseUrl}/realtime/v1/runs${searchParams ? `?${searchParams}` : ""}`,
      {
        closeOnComplete: false,
        headers: this.#getRealtimeHeaders(),
        client: this,
        signal: options?.signal,
        onFetchError: options?.onFetchError,
      }
    );
  }

  subscribeToBatch<TRunTypes extends AnyRunTypes>(
    batchId: string,
    options?: {
      signal?: AbortSignal;
      onFetchError?: (error: Error) => void;
      skipColumns?: string[];
    }
  ) {
    const queryParams = new URLSearchParams();

    if (options?.skipColumns) {
      queryParams.append("skipColumns", options.skipColumns.join(","));
    }

    return runShapeStream<TRunTypes>(
      `${this.baseUrl}/realtime/v1/batches/${batchId}${queryParams ? `?${queryParams}` : ""}`,
      {
        closeOnComplete: false,
        headers: this.#getRealtimeHeaders(),
        client: this,
        signal: options?.signal,
        onFetchError: options?.onFetchError,
      }
    );
  }

  async fetchStream<T>(
    runId: string,
    streamKey: string,
    options?: { signal?: AbortSignal; baseUrl?: string }
  ): Promise<AsyncIterableStream<T>> {
    const streamFactory = new SSEStreamSubscriptionFactory(options?.baseUrl ?? this.baseUrl, {
      headers: this.getHeaders(),
      signal: options?.signal,
    });

    const subscription = streamFactory.createSubscription(runId, streamKey);

    const stream = await subscription.subscribe();

    return stream as AsyncIterableStream<T>;
  }

  async generateJWTClaims(requestOptions?: ZodFetchOptions): Promise<Record<string, any>> {
    return zodfetch(
      z.record(z.any()),
      `${this.baseUrl}/api/v1/auth/jwt/claims`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  retrieveBatch(batchId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      RetrieveBatchV2Response,
      `${this.baseUrl}/api/v2/batches/${batchId}`,
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  #getHeaders(spanParentAsLink: boolean, additionalHeaders?: Record<string, string | undefined>) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.accessToken}`,
      "trigger-version": VERSION,
      ...Object.entries(additionalHeaders ?? {}).reduce(
        (acc, [key, value]) => {
          if (value !== undefined) {
            acc[key] = value;
          }

          return acc;
        },
        {} as Record<string, string>
      ),
    };

    if (this.previewBranch) {
      headers["x-trigger-branch"] = this.previewBranch;
    }

    // Only inject the context if we are inside a task
    if (taskContext.isInsideTask) {
      headers["x-trigger-worker"] = "true";
      // Only pass the engine version if we are inside a task
      headers["x-trigger-engine-version"] = "V2";

      if (spanParentAsLink) {
        headers["x-trigger-span-parent-as-link"] = "1";
      }
    }

    if (typeof window !== "undefined" && typeof window.document !== "undefined") {
      headers["x-trigger-client"] = "browser";
    }

    headers[API_VERSION_HEADER_NAME] = API_VERSION;

    return headers;
  }

  #getRealtimeHeaders() {
    let headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      "trigger-version": VERSION,
    };

    if (this.previewBranch) {
      headers["x-trigger-branch"] = this.previewBranch;
    }

    return headers;
  }
}

function createSearchQueryForSubscribeToRuns(query?: SubscribeToRunsQueryParams): URLSearchParams {
  const searchParams = new URLSearchParams();

  if (query) {
    if (query.tasks) {
      searchParams.append(
        "tasks",
        Array.isArray(query.tasks) ? query.tasks.join(",") : query.tasks
      );
    }

    if (query.tags) {
      searchParams.append("tags", Array.isArray(query.tags) ? query.tags.join(",") : query.tags);
    }

    if (query.createdAt) {
      searchParams.append("createdAt", query.createdAt);
    }

    if (query.skipColumns) {
      searchParams.append("skipColumns", query.skipColumns.join(","));
    }
  }

  return searchParams;
}

function createSearchQueryForListRuns(query?: ListRunsQueryParams): URLSearchParams {
  const searchParams = new URLSearchParams();

  if (query) {
    if (query.status) {
      searchParams.append(
        "filter[status]",
        Array.isArray(query.status) ? query.status.join(",") : query.status
      );
    }

    if (query.taskIdentifier) {
      searchParams.append(
        "filter[taskIdentifier]",
        Array.isArray(query.taskIdentifier) ? query.taskIdentifier.join(",") : query.taskIdentifier
      );
    }

    if (query.version) {
      searchParams.append(
        "filter[version]",
        Array.isArray(query.version) ? query.version.join(",") : query.version
      );
    }

    if (query.bulkAction) {
      searchParams.append("filter[bulkAction]", query.bulkAction);
    }

    if (query.tag) {
      searchParams.append(
        "filter[tag]",
        Array.isArray(query.tag) ? query.tag.join(",") : query.tag
      );
    }

    if (query.schedule) {
      searchParams.append("filter[schedule]", query.schedule);
    }

    if (typeof query.isTest === "boolean") {
      searchParams.append("filter[isTest]", String(query.isTest));
    }

    if (query.from) {
      searchParams.append(
        "filter[createdAt][from]",
        query.from instanceof Date ? query.from.getTime().toString() : query.from.toString()
      );
    }

    if (query.to) {
      searchParams.append(
        "filter[createdAt][to]",
        query.to instanceof Date ? query.to.getTime().toString() : query.to.toString()
      );
    }

    if (query.period) {
      searchParams.append("filter[createdAt][period]", query.period);
    }

    if (query.batch) {
      searchParams.append("filter[batch]", query.batch);
    }

    if (query.queue) {
      searchParams.append(
        "filter[queue]",
        Array.isArray(query.queue)
          ? query.queue.map((q) => queueNameFromQueueTypeName(q)).join(",")
          : queueNameFromQueueTypeName(query.queue)
      );
    }

    if (query.queue) {
      searchParams.append(
        "filter[queue]",
        Array.isArray(query.queue)
          ? query.queue.map((q) => queueNameFromQueueTypeName(q)).join(",")
          : queueNameFromQueueTypeName(query.queue)
      );
    }

    if (query.machine) {
      searchParams.append(
        "filter[machine]",
        Array.isArray(query.machine) ? query.machine.join(",") : query.machine
      );
    }
  }

  return searchParams;
}

function queueNameFromQueueTypeName(queue: QueueTypeName): string {
  if (queue.type === "task") {
    return `task/${queue.name}`;
  }

  return queue.name;
}

function createSearchQueryForListWaitpointTokens(
  query?: ListWaitpointTokensQueryParams
): URLSearchParams {
  const searchParams = new URLSearchParams();

  if (query) {
    if (query.status) {
      searchParams.append(
        "filter[status]",
        Array.isArray(query.status) ? query.status.join(",") : query.status
      );
    }

    if (query.idempotencyKey) {
      searchParams.append("filter[idempotencyKey]", query.idempotencyKey);
    }

    if (query.tags) {
      searchParams.append(
        "filter[tags]",
        Array.isArray(query.tags) ? query.tags.join(",") : query.tags
      );
    }

    if (query.period) {
      searchParams.append("filter[createdAt][period]", query.period);
    }

    if (query.from) {
      searchParams.append(
        "filter[createdAt][from]",
        query.from instanceof Date ? query.from.getTime().toString() : query.from.toString()
      );
    }

    if (query.to) {
      searchParams.append(
        "filter[createdAt][to]",
        query.to instanceof Date ? query.to.getTime().toString() : query.to.toString()
      );
    }
  }

  return searchParams;
}

export function mergeRequestOptions(
  defaultOptions: AnyZodFetchOptions,
  options?: ApiRequestOptions
): AnyZodFetchOptions {
  if (!options) {
    return defaultOptions;
  }

  return {
    ...defaultOptions,
    ...options,
    retry: {
      ...defaultOptions.retry,
      ...options.retry,
    },
  };
}
