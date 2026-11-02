import { nanoid } from "nanoid";
import { z } from "zod/v4";
import { VERSION } from "../../version.js";
import { isAdditionalApiKey } from "../apiKeys.js";
import { isRunToken } from "../runToken.js";
import type { ApiClientConfiguration } from "../apiClientManager-api.js";
import { generateJWT } from "../jwt.js";
import { isRunTokenOperation } from "../runTokenOperations.js";
import type { RunTokenSelectionReason } from "../runTokenTelemetry.js";
import {
  SDK_CREDENTIAL_OPERATION_HEADER,
  SDK_CREDENTIAL_REASON_HEADER,
} from "../sdkCredentialTelemetry.js";
import {
  type AddTagsRequestBody,
  type ApiDeploymentListOptions,
  type BatchItemNDJSON,
  type BatchTriggerTaskV3RequestBody,
  type CloseSessionRequestBody,
  type CompleteWaitpointTokenRequestBody,
  type CreateBatchRequestBody,
  type CreateEnvironmentVariableRequestBody,
  type CreateInputStreamWaitpointRequestBody,
  type CreatePromptOverrideRequestBody,
  ListWebhookEndpointsResponse,
  ListWebhookDeliveriesResponse,
  type ListWebhookDeliveriesQuery,
  ReplayWebhookDeliveryResponse,
  WebhookDeliveryObject,
  CancelWebhookWaiterResponseBody,
  CreateWebhookWaiterResponseBody,
  type CreateWebhookWaiterRequestBody,
  type RotateWebhookEndpointSecretRequestBody,
  RotateWebhookEndpointSecretResponse,
  SetWebhookEndpointSecretResponse,
  type SetWebhookEndpointSecretRequestBody,
  WebhookEndpointDetailObject,
  type CreateScheduleOptions,
  type CreateSessionRequestBody,
  type CreateSessionStreamWaitpointRequestBody,
  type CreateWaitpointTokenRequestBody,
  type EndAndContinueSessionRequestBody,
  type ListQueueOptions,
  type ListConcurrencyLimitOptions,
  ConcurrencyLimitItem,
  ConcurrencyLimitKeyItem,
  type OverrideConcurrencyLimitBoundsBody,
  type OverrideConcurrencyLimitKeyBody,
  type ResetConcurrencyLimitRequestBody,
  type ListScheduleOptions,
  type ListSessionsOptions,
  type PromotePromptVersionRequestBody,
  type QueueTypeName,
  type ReactivatePromptOverrideRequestBody,
  ReplayRunRequestBody,
  type RescheduleRunRequestBody,
  type ResolvePromptRequestBody,
  type RetrieveQueueParam,
  type RetryOptions,
  type TriggerTaskRequestBody,
  type UpdateEnvironmentVariableRequestBody,
  type UpdateMetadataRequestBody,
  type UpdatePromptOverrideRequestBody,
  type UpdateScheduleOptions,
  type UpdateSessionRequestBody,
  type WaitForDurationRequestBody,
  AbortBulkActionResponseBody,
  ApiDeploymentListResponseItem,
  BulkActionObject,
  CreateBulkActionResponseBody,
  AppendToStreamResponseBody,
  BatchTaskRunExecutionResult,
  BatchTriggerTaskV3Response,
  CanceledRunResponse,
  CompleteWaitpointTokenResponseBody,
  CreateBatchResponse,
  CreateInputStreamWaitpointResponseBody,
  CreateSessionStreamWaitpointResponseBody,
  CreateStreamResponseBody,
  CreateUploadPayloadUrlResponseBody,
  SessionTranscriptResponseBody,
  CreateWaitpointTokenResponseBody,
  CreatedSessionResponseBody,
  DeletedScheduleObject,
  EndAndContinueSessionResponseBody,
  EnvironmentVariableResponseBody,
  EnvironmentVariableWithSecret,
  ListDashboardsResponseBody,
  AddDashboardWidgetResponseBody,
  type AddDashboardWidgetRequestBody,
  type CreateDashboardRequestBody,
  DashboardObject,
  DeleteDashboardResponseBody,
  type ReplaceDashboardRequestBody,
  type UpdateDashboardRequestBody,
  type UpdateDashboardWidgetRequestBody,
  ListPromptVersionsResponseBody,
  ListPromptsResponseBody,
  ListRunResponseItem,
  ListedSessionItem,
  PromptOkResponseBody,
  PromptOverrideCreatedResponseBody,
  QueryExecuteResponseBody,
  QuerySchemaResponseBody,
  QueueItem,
  ReadSessionStreamRecordsResponseBody,
  ReplayRunResponse,
  type ReportFormat,
  type ReportViewModel,
  ReportViewModelSchema,
  ResetIdempotencyKeyResponse,
  ResolvePromptResponseBody,
  RetrieveBatchV2Response,
  RetrieveCurrentDeploymentResponseBody,
  RetrieveRunResponse,
  RetrieveRunTraceResponseBody,
  RetrieveRunTracePageResponseBody,
  RetrieveSessionResponseBody,
  RetrieveSpanDetailResponseBody,
  ScheduleObject,
  SendInputStreamResponseBody,
  StreamBatchItemsResponse,
  TaskRunExecutionResult,
  TriggerTaskResponse,
  UpdateMetadataResponseBody,
  WaitForDurationResponseBody,
  WaitForWaitpointTokenResponseBody,
  WaitpointRetrieveTokenResponse,
  WaitpointTokenItem,
} from "../schemas/index.js";
import { controlSubtype, type ControlEvent } from "../sessionStreams/wireProtocol.js";
import type { AsyncIterableStream } from "../streams/asyncIterableStream.js";
import { taskContext } from "../task-context-api.js";
import type { AnyRunTypes, TriggerJwtOptions } from "../types/tasks.js";
import type { Prettify } from "../types/utils.js";
import superjson from "../imports/superjson.js";
import { getEnvVar } from "../utils/getEnv.js";
import { calculateNextRetryDelay } from "../utils/retries.js";
import {
  type AnyZodFetchOptions,
  type ApiPromise,
  type ApiRequestOptions,
  type CursorPagePromise,
  type ZodFetchOptions,
  isRequestOptions,
  zodfetch,
  zodfetchCursorPage,
  zodfetchOffsetLimitPage,
} from "./core.js";
import { encodeTaskIdForPath } from "./encodeTaskIdForPath.js";
import { ApiConnectionError, ApiError, BatchNotSealedError } from "./errors.js";
import { refreshAccessTokenOnce, type RefreshAccessTokenFn } from "./refreshAccessToken.js";
import {
  type AnyRealtimeRun,
  type AnyRunShape,
  type RealtimeRun,
  type RealtimeRunSkipColumns,
  type RunShape,
  type RunStreamCallback,
  type RunSubscription,
  type TaskRunShape,
  SSEStreamSubscription,
  SSEStreamSubscriptionFactory,
  runShapeStream,
  type SSEStreamPart,
  STREAM_START_HEADER,
} from "./runStream.js";
import type {
  CreateBulkActionOptions,
  CreateEnvironmentVariableParams,
  ImportEnvironmentVariablesParams,
  ListBulkActionsQueryParams,
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

export type CreateBatchApiResponse = Prettify<
  CreateBatchResponse & {
    publicAccessToken: string;
  }
>;

export type {
  CreateBulkActionOptions,
  CreateEnvironmentVariableParams,
  ImportEnvironmentVariablesParams,
  RealtimeRunSkipColumns,
  ListBulkActionsQueryParams,
  SubscribeToRunsQueryParams,
  UpdateEnvironmentVariableParams,
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
  clientConfig?: ApiClientConfiguration;
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

export type ApiClientFutureFlags = {
  v2RealtimeStreams?: boolean;
};

export { SSEStreamSubscription, STREAM_START_HEADER, isRequestOptions };
export type {
  AnyRealtimeRun,
  AnyRunShape,
  ApiRequestOptions,
  ControlEvent,
  RealtimeRun,
  RunShape,
  RunStreamCallback,
  RunSubscription,
  SSEStreamPart,
  TaskRunShape,
};

export * from "./getBranch.js";
export { encodeTaskIdForPath } from "./encodeTaskIdForPath.js";

export type CreatePublicTokenRequestBody = {
  scopes: string[];
  expirationTime?: string | number;
  oneTimeUse?: boolean;
  realtime?: { skipColumns?: string[] };
};

const CreatePublicTokenResponseBody = z.object({ token: z.string() });

/**
 * Trigger.dev v3 API client
 */
export class ApiClient {
  public readonly baseUrl: string;
  // ponytail: the configured credential, so the root key while it is injected into runs.
  // TRI-15076 decides this property's contract once runs only receive run tokens.
  public readonly accessToken: string;
  public readonly previewBranch?: string;
  public readonly futureFlags: ApiClientFutureFlags;
  private readonly additionalHeaders?: Record<string, string>;
  private readonly defaultRequestOptions: ZodFetchOptions;
  private readonly refreshAccessToken?: RefreshAccessTokenFn;

  constructor(
    baseUrl: string,
    accessToken: string,
    // Carries the branch for any branchable env (preview or dev) — both ride the
    // x-trigger-branch header, and the server disambiguates by the token's env.
    previewBranch?: string,
    requestOptions: ApiRequestOptions = {},
    futureFlags: ApiClientFutureFlags = {},
    refreshAccessToken?: RefreshAccessTokenFn,
    private readonly resolveAccessToken?: (
      operation: string,
      recordSelection: boolean
    ) => string | { accessToken: string | undefined; reason: RunTokenSelectionReason } | undefined
  ) {
    this.accessToken = accessToken;
    this.refreshAccessToken = refreshAccessToken;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.previewBranch = previewBranch;
    const { additionalHeaders, ...restRequestOptions } = requestOptions;
    this.additionalHeaders = additionalHeaders;
    this.defaultRequestOptions = mergeRequestOptions(DEFAULT_ZOD_FETCH_OPTIONS, restRequestOptions);
    this.futureFlags = futureFlags;
  }

  getAccessToken(operation: string, recordSelection = false): string {
    return this.getAuthenticationHeaders(operation, recordSelection).Authorization.slice(
      "Bearer ".length
    );
  }

  getAuthenticationHeaders(
    operation: string,
    recordSelection = true
  ): Record<string, string> & { Authorization: string } {
    const selection = this.resolveAccessToken
      ? this.resolveAccessToken(operation, recordSelection)
      : this.accessToken;
    const token = typeof selection === "object" ? selection.accessToken : selection;
    if (!token) throw new Error(`No API credential available for ${operation}`);
    const headers: Record<string, string> & { Authorization: string } = {
      Authorization: `Bearer ${token}`,
    };
    if (
      typeof selection === "object" &&
      taskContext.isInsideTask &&
      selection.reason !== "outside_task" &&
      !this.refreshAccessToken &&
      isRunTokenOperation(operation)
    ) {
      headers["x-trigger-worker"] = "true";
      headers[SDK_CREDENTIAL_OPERATION_HEADER] = operation;
      headers[SDK_CREDENTIAL_REASON_HEADER] = selection.reason;
    }
    return headers;
  }

  /**
   * Key for signing a public access token locally. Only root keys can do this —
   * an additional key isn't the environment's signing material, so a token
   * signed with one would never verify. Throw rather than return a dead token.
   */
  get #selfSigningKey(): string {
    if (isAdditionalApiKey(this.accessToken) || isRunToken(this.accessToken)) {
      throw new Error(
        "This credential cannot self-sign public tokens, and the server did not return one. Upgrade the server or use the root API key."
      );
    }

    return this.accessToken;
  }

  get fetchClient(): typeof fetch {
    const fetchClient: typeof fetch = (input, requestInit) => {
      const $requestInit: RequestInit = {
        ...requestInit,
        headers: {
          ...requestInit?.headers,
          ...this.#getHeaders(false, undefined, "default", true),
        },
      };

      return fetch(input, $requestInit);
    };

    return fetchClient;
  }

  getHeaders(operation = "unknown") {
    return this.#getHeaders(false, undefined, operation, true);
  }

  #requestOptions(
    operation: string,
    options?: ApiRequestOptions,
    defaults = this.defaultRequestOptions
  ): AnyZodFetchOptions {
    return {
      ...mergeRequestOptions(defaults, options),
      resolveHeaders: () => this.getAuthenticationHeaders(operation),
    };
  }

  #requestFetch(operation: string, fetchClient?: typeof fetch): typeof fetch | undefined {
    if (!this.resolveAccessToken || this.refreshAccessToken) return fetchClient;
    return (input, init) => {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined)
      );
      headers.delete(SDK_CREDENTIAL_OPERATION_HEADER);
      headers.delete(SDK_CREDENTIAL_REASON_HEADER);
      for (const [key, value] of Object.entries(this.getAuthenticationHeaders(operation))) {
        headers.set(key, value);
      }
      return (fetchClient ?? fetch)(input, { ...init, headers });
    };
  }

  /**
   * Header resolver handed to stream subscriptions so a connection rejected with
   * a 401/403 can reconnect with a freshly minted token. `undefined` when no
   * `refreshAccessToken` was configured, which keeps auth errors terminal.
   */
  #resolveStreamHeaders(operation: string): (() => Promise<Record<string, string>>) | undefined {
    const refreshAccessToken = this.refreshAccessToken;
    if (!refreshAccessToken) return undefined;

    return async () => {
      const accessToken = await refreshAccessTokenOnce(refreshAccessToken);
      return this.#getHeaders(false, { Authorization: `Bearer ${accessToken}` }, operation);
    };
  }

  /** As {@link ApiClient.#resolveStreamHeaders}, for the leaner realtime header set. */
  #resolveRealtimeHeaders(operation: string): (() => Promise<Record<string, string>>) | undefined {
    const refreshAccessToken = this.refreshAccessToken;
    if (!refreshAccessToken) return undefined;

    return async () => {
      const accessToken = await refreshAccessTokenOnce(refreshAccessToken);
      return { ...this.#getRealtimeHeaders(operation), Authorization: `Bearer ${accessToken}` };
    };
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
          headers: this.#getHeaders(false, undefined, "getRunResult"),
        },
        this.#requestOptions("getRunResult", requestOptions)
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
        headers: this.#getHeaders(false, undefined, "getBatchResults"),
      },
      this.#requestOptions("getBatchResults", requestOptions)
    );
  }

  triggerTask(
    taskId: string,
    body: TriggerTaskRequestBody,
    clientOptions?: ClientTriggerOptions,
    requestOptions?: TriggerRequestOptions
  ) {
    const encodedTaskId = encodeTaskIdForPath(taskId);

    return zodfetch(
      TriggerTaskResponse,
      `${this.baseUrl}/api/v1/tasks/${encodedTaskId}/trigger`,
      {
        method: "POST",
        headers: this.#getHeaders(
          clientOptions?.spanParentAsLink ?? false,
          undefined,
          "triggerTask"
        ),
        body: JSON.stringify(body),
      },
      this.#requestOptions("triggerTask", requestOptions)
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
          secretKey: this.#selfSigningKey,
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
        headers: this.#getHeaders(
          clientOptions?.spanParentAsLink ?? false,
          {
            "batch-processing-strategy": clientOptions?.processingStrategy,
          },
          "batchTriggerV3"
        ),
        body: JSON.stringify(body),
      },
      this.#requestOptions("batchTriggerV3", requestOptions)
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
          secretKey: this.#selfSigningKey,
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

  /**
   * Phase 1 of 2-phase batch API: Create a batch
   *
   * Creates a new batch and returns its ID. For batchTriggerAndWait,
   * the parent run is blocked immediately on batch creation.
   *
   * @param body - The batch creation parameters
   * @param clientOptions - Options for trace context handling
   * @param clientOptions.spanParentAsLink - If true, child runs will have separate trace IDs with a link to parent
   * @param requestOptions - Optional request options
   * @returns The created batch with ID and metadata
   */
  createBatch(
    body: CreateBatchRequestBody,
    clientOptions?: ClientTriggerOptions,
    requestOptions?: TriggerRequestOptions
  ) {
    return zodfetch(
      CreateBatchResponse,
      `${this.baseUrl}/api/v3/batches`,
      {
        method: "POST",
        headers: this.#getHeaders(
          clientOptions?.spanParentAsLink ?? false,
          undefined,
          "createBatch"
        ),
        body: JSON.stringify(body),
      },
      this.#requestOptions("createBatch", requestOptions)
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
          secretKey: this.#selfSigningKey,
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

  /**
   * Phase 2 of 2-phase batch API: Stream batch items
   *
   * Streams batch items as NDJSON to the server. Each item is enqueued
   * as it arrives. The batch is automatically sealed when the stream completes.
   *
   * Includes automatic retry with exponential backoff. Since items are deduplicated
   * by index on the server, retrying the entire stream is safe.
   *
   * Uses ReadableStream.tee() for retry capability without buffering all items
   * upfront - only items consumed before a failure are buffered for retry.
   *
   * @param batchId - The batch ID from createBatch
   * @param items - Array or async iterable of batch items
   * @param requestOptions - Optional request options
   * @returns Summary of items accepted and deduplicated
   */
  async streamBatchItems(
    batchId: string,
    items: BatchItemNDJSON[] | AsyncIterable<BatchItemNDJSON>,
    requestOptions?: ApiRequestOptions
  ): Promise<StreamBatchItemsResponse> {
    // Convert input to ReadableStream for uniform handling and tee() support
    const stream = createNdjsonStream(items);

    const retryOptions = {
      ...DEFAULT_STREAM_BATCH_RETRY_OPTIONS,
      ...requestOptions?.retry,
    };

    return this.#streamBatchItemsWithRetry(batchId, stream, retryOptions);
  }

  async #streamBatchItemsWithRetry(
    batchId: string,
    stream: ReadableStream<Uint8Array>,
    retryOptions: RetryOptions,
    attempt: number = 1
  ): Promise<StreamBatchItemsResponse> {
    const headers = this.#getHeaders(false, undefined, "streamBatchItems", true);
    headers["Content-Type"] = "application/x-ndjson";

    // Tee the stream: one branch for this attempt, one for potential retry
    // tee() internally buffers data consumed from one branch for the other,
    // so we only buffer what's been sent before a failure occurs
    const [forRequest, forRetry] = stream.tee();

    try {
      const response = await fetch(`${this.baseUrl}/api/v3/batches/${batchId}/items`, {
        method: "POST",
        headers,
        body: forRequest,
        // @ts-expect-error - duplex is required for streaming body but not in types
        duplex: "half",
      });

      if (!response.ok) {
        const retryResult = shouldRetryStreamBatchItems(response, attempt, retryOptions);

        if (retryResult.retry) {
          // Cancel the request stream before retry to prevent tee() from buffering
          await safeStreamCancel(forRequest);
          await sleep(retryResult.delay);
          // Use the backup stream for retry
          return this.#streamBatchItemsWithRetry(batchId, forRetry, retryOptions, attempt + 1);
        }

        // Not retrying - cancel the backup stream
        await safeStreamCancel(forRetry);

        const errText = await response.text().catch((e) => (e as Error).message);
        let errJSON: object | undefined;
        try {
          errJSON = JSON.parse(errText) as object;
        } catch {
          // ignore
        }
        const errMessage = errJSON ? undefined : errText;
        const responseHeaders = Object.fromEntries(response.headers.entries());

        throw ApiError.generate(response.status, errJSON, errMessage, responseHeaders);
      }

      const result = await response.json();
      const parsed = StreamBatchItemsResponse.safeParse(result);

      if (!parsed.success) {
        // Cancel backup stream since we're throwing
        await safeStreamCancel(forRetry);
        throw new Error(
          `Invalid response from server for batch ${batchId}: ${parsed.error.message}`
        );
      }

      // Check if the batch was sealed
      if (!parsed.data.sealed) {
        // Not all items were received - treat as retryable condition
        const delay = calculateNextRetryDelay(retryOptions, attempt);

        if (delay) {
          // Cancel the request stream before retry to prevent tee() from buffering
          await safeStreamCancel(forRequest);
          // Retry with the backup stream
          await sleep(delay);
          return this.#streamBatchItemsWithRetry(batchId, forRetry, retryOptions, attempt + 1);
        }

        // No more retries - cancel backup stream and throw descriptive error
        await safeStreamCancel(forRetry);
        throw new BatchNotSealedError({
          batchId,
          enqueuedCount: parsed.data.enqueuedCount ?? 0,
          expectedCount: parsed.data.expectedCount ?? 0,
          itemsAccepted: parsed.data.itemsAccepted,
          itemsDeduplicated: parsed.data.itemsDeduplicated,
        });
      }

      // Success - cancel the backup stream to release resources
      await safeStreamCancel(forRetry);

      return parsed.data;
    } catch (error) {
      // Don't retry BatchNotSealedError (retries already exhausted)
      if (error instanceof BatchNotSealedError) {
        throw error;
      }
      // Don't retry ApiErrors (already handled above with backup stream cancelled)
      if (error instanceof ApiError) {
        throw error;
      }

      // Retry connection errors using the backup stream
      const delay = calculateNextRetryDelay(retryOptions, attempt);
      if (delay) {
        // Cancel the request stream before retry to prevent tee() from buffering
        await safeStreamCancel(forRequest);
        await sleep(delay);
        return this.#streamBatchItemsWithRetry(batchId, forRetry, retryOptions, attempt + 1);
      }

      // No more retries - cancel the backup stream
      await safeStreamCancel(forRetry);

      // Wrap in a more descriptive error
      const cause = error instanceof Error ? error : new Error(String(error));
      throw new ApiConnectionError({
        cause,
        message: `Failed to stream batch items for batch ${batchId}: ${cause.message}`,
      });
    }
  }

  createUploadPayloadUrl(filename: string, requestOptions?: ZodFetchOptions) {
    const encoded = encodeURIComponent(filename);
    return zodfetch(
      CreateUploadPayloadUrlResponseBody,
      `${this.baseUrl}/api/v2/packets/${encoded}`,
      {
        method: "PUT",
        headers: this.#getHeaders(false, undefined, "createUploadPayloadUrl"),
      },
      this.#requestOptions("createUploadPayloadUrl", requestOptions)
    );
  }

  getPayloadUrl(filename: string, requestOptions?: ZodFetchOptions) {
    const encoded = encodeURIComponent(filename);
    return zodfetch(
      CreateUploadPayloadUrlResponseBody,
      `${this.baseUrl}/api/v1/packets/${encoded}`,
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "getPayloadUrl"),
      },
      this.#requestOptions("getPayloadUrl", requestOptions)
    );
  }

  /**
   * Presigned GET URL for a run's stored payload or output, authorized against the run.
   * Falls back to the legacy packet route on servers that predate this endpoint.
   */
  async getRunPacketUrl(
    runId: string,
    field: "payload" | "output",
    path: string,
    requestOptions?: ZodFetchOptions
  ) {
    try {
      return await zodfetch(
        CreateUploadPayloadUrlResponseBody,
        `${this.baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/packets/${field}`,
        {
          method: "GET",
          headers: this.#getHeaders(false, undefined, "getRunPacketUrl"),
        },
        this.#requestOptions("getRunPacketUrl", requestOptions)
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return await this.getPayloadUrl(path, requestOptions);
      }

      throw error;
    }
  }

  /** Presigned PUT URL for a `chat.agent` session snapshot. */
  createChatSnapshotUploadUrl(sessionId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      CreateUploadPayloadUrlResponseBody,
      `${this.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/snapshot-url`,
      {
        method: "PUT",
        headers: this.#getHeaders(false, undefined, "createChatSnapshotUploadUrl"),
      },
      this.#requestOptions("createChatSnapshotUploadUrl", requestOptions)
    );
  }

  /** Presigned GET URL for a `chat.agent` session snapshot. */
  getChatSnapshotUrl(sessionId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      CreateUploadPayloadUrlResponseBody,
      `${this.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/snapshot-url`,
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "getChatSnapshotUrl"),
      },
      this.#requestOptions("getChatSnapshotUrl", requestOptions)
    );
  }

  /**
   * One page of a `chat.agent` session's persisted transcript, most recent
   * messages first when `limit` is set. Secret key only.
   */
  getSessionTranscript(
    sessionId: string,
    options?: { limit?: number; before?: string },
    requestOptions?: ZodFetchOptions
  ) {
    const query = new URLSearchParams();
    if (options?.limit !== undefined) query.set("limit", String(options.limit));
    if (options?.before !== undefined) query.set("before", options.before);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return zodfetch(
      SessionTranscriptResponseBody,
      `${this.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript${suffix}`,
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "getSessionTranscript"),
      },
      this.#requestOptions("getSessionTranscript", requestOptions)
    );
  }

  retrieveRun(runId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      RetrieveRunResponse,
      `${this.baseUrl}/api/v3/runs/${runId}`,
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "retrieveRun"),
      },
      this.#requestOptions("retrieveRun", requestOptions)
    );
  }

  retrieveRunTrace(runId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      RetrieveRunTraceResponseBody,
      `${this.baseUrl}/api/v1/runs/${runId}/trace`,
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "retrieveRunTrace"),
      },
      this.#requestOptions("retrieveRunTrace", requestOptions)
    );
  }

  /**
   * Retrieves one page of a root run's trace as flat spans. Omit `after` for the first
   * page, then pass back `pagination.next` until it's missing. Use `assembleRunTracePages`
   * to rebuild the tree. Spans are lean: fetch a span's events and properties with
   * `retrieveSpan`.
   */
  retrieveRunTracePage(
    runId: string,
    options?: { limit?: number; after?: string },
    requestOptions?: ZodFetchOptions
  ) {
    const query = new URLSearchParams();
    query.set("page[size]", String(options?.limit ?? 10_000));
    if (options?.after !== undefined) query.set("page[after]", options.after);

    return zodfetch(
      RetrieveRunTracePageResponseBody,
      `${this.baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/trace?${query.toString()}`,
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "retrieveRunTracePage"),
      },
      this.#requestOptions("retrieveRunTracePage", requestOptions)
    );
  }

  retrieveSpan(runId: string, spanId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      RetrieveSpanDetailResponseBody,
      `${this.baseUrl}/api/v1/runs/${runId}/spans/${spanId}`,
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "retrieveSpan"),
      },
      this.#requestOptions("retrieveSpan", requestOptions)
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
        headers: this.#getHeaders(false, undefined, "listRuns"),
      },
      this.#requestOptions("listRuns", requestOptions)
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
        headers: this.#getHeaders(false, undefined, "listProjectRuns"),
      },
      this.#requestOptions("listProjectRuns", requestOptions)
    );
  }

  replayRun(runId: string, requestOptions?: ZodFetchOptions): ApiPromise<ReplayRunResponse>;
  replayRun(
    runId: string,
    body?: ReplayRunRequestBody,
    requestOptions?: ZodFetchOptions
  ): ApiPromise<ReplayRunResponse>;
  replayRun(
    runId: string,
    bodyOrRequestOptions?: ReplayRunRequestBody | ZodFetchOptions,
    requestOptions?: ZodFetchOptions
  ): ApiPromise<ReplayRunResponse> {
    const isBody =
      bodyOrRequestOptions !== undefined &&
      Object.keys(bodyOrRequestOptions).every((key) => key in ReplayRunRequestBody.shape);
    const body = isBody ? (bodyOrRequestOptions as ReplayRunRequestBody) : undefined;
    const $requestOptions = isBody
      ? requestOptions
      : ((bodyOrRequestOptions as ZodFetchOptions | undefined) ?? requestOptions);

    return zodfetch(
      ReplayRunResponse,
      `${this.baseUrl}/api/v1/runs/${runId}/replay`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "replayRun"),
        body: body ? JSON.stringify(withSuperJsonPayload(body)) : undefined,
      },
      this.#requestOptions("replayRun", $requestOptions)
    );
  }

  cancelRun(runId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      CanceledRunResponse,
      `${this.baseUrl}/api/v2/runs/${runId}/cancel`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "cancelRun"),
      },
      this.#requestOptions("cancelRun", requestOptions)
    );
  }

  createBulkAction(options: CreateBulkActionOptions, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      CreateBulkActionResponseBody,
      `${this.baseUrl}/api/v1/bulk-actions`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "createBulkAction"),
        body: JSON.stringify(options),
      },
      this.#requestOptions("createBulkAction", requestOptions)
    );
  }

  listBulkActions(
    query?: ListBulkActionsQueryParams,
    requestOptions?: ZodFetchOptions
  ): CursorPagePromise<typeof BulkActionObject> {
    return zodfetchCursorPage(
      BulkActionObject,
      `${this.baseUrl}/api/v1/bulk-actions`,
      {
        query: new URLSearchParams(),
        limit: query?.limit,
        after: query?.after,
        before: query?.before,
      },
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "listBulkActions"),
      },
      this.#requestOptions("listBulkActions", requestOptions)
    );
  }

  retrieveBulkAction(bulkActionId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      BulkActionObject,
      `${this.baseUrl}/api/v1/bulk-actions/${bulkActionId}`,
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "retrieveBulkAction"),
      },
      this.#requestOptions("retrieveBulkAction", requestOptions)
    );
  }

  abortBulkAction(bulkActionId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      AbortBulkActionResponseBody,
      `${this.baseUrl}/api/v1/bulk-actions/${bulkActionId}/abort`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "abortBulkAction"),
      },
      this.#requestOptions("abortBulkAction", requestOptions)
    );
  }

  resetIdempotencyKey(
    taskIdentifier: string,
    idempotencyKey: string,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      ResetIdempotencyKeyResponse,
      `${this.baseUrl}/api/v1/idempotencyKeys/${encodeURIComponent(idempotencyKey)}/reset`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "resetIdempotencyKey"),
        body: JSON.stringify({ taskIdentifier }),
      },
      this.#requestOptions("resetIdempotencyKey", requestOptions)
    );
  }

  rescheduleRun(runId: string, body: RescheduleRunRequestBody, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      RetrieveRunResponse,
      `${this.baseUrl}/api/v1/runs/${runId}/reschedule`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "rescheduleRun"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("rescheduleRun", requestOptions)
    );
  }

  listRunEvents(runId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      z.any(), // TODO: define a proper schema for this
      `${this.baseUrl}/api/v1/runs/${runId}/events`,
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "listRunEvents"),
      },
      this.#requestOptions("listRunEvents", requestOptions)
    );
  }

  addTags(runId: string, body: AddTagsRequestBody, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      z.object({ message: z.string() }),
      `${this.baseUrl}/api/v1/runs/${runId}/tags`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "addTags"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("addTags", requestOptions)
    );
  }

  createSchedule(options: CreateScheduleOptions, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      ScheduleObject,
      `${this.baseUrl}/api/v1/schedules`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "createSchedule"),
        body: JSON.stringify(options),
      },
      this.#requestOptions("createSchedule", requestOptions)
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
        headers: this.#getHeaders(false, undefined, "listSchedules"),
      },
      this.#requestOptions("listSchedules", requestOptions)
    );
  }

  retrieveSchedule(scheduleId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      ScheduleObject,
      `${this.baseUrl}/api/v1/schedules/${scheduleId}`,
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "retrieveSchedule"),
      },
      this.#requestOptions("retrieveSchedule", requestOptions)
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
        headers: this.#getHeaders(false, undefined, "updateSchedule"),
        body: JSON.stringify(options),
      },
      this.#requestOptions("updateSchedule", requestOptions)
    );
  }

  deactivateSchedule(scheduleId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      ScheduleObject,
      `${this.baseUrl}/api/v1/schedules/${scheduleId}/deactivate`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "deactivateSchedule"),
      },
      this.#requestOptions("deactivateSchedule", requestOptions)
    );
  }

  activateSchedule(scheduleId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      ScheduleObject,
      `${this.baseUrl}/api/v1/schedules/${scheduleId}/activate`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "activateSchedule"),
      },
      this.#requestOptions("activateSchedule", requestOptions)
    );
  }

  deleteSchedule(scheduleId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      DeletedScheduleObject,
      `${this.baseUrl}/api/v1/schedules/${scheduleId}`,
      {
        method: "DELETE",
        headers: this.#getHeaders(false, undefined, "deleteSchedule"),
      },
      this.#requestOptions("deleteSchedule", requestOptions)
    );
  }

  listEnvVars(projectRef: string, slug: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      z.array(EnvironmentVariableWithSecret),
      `${this.baseUrl}/api/v1/projects/${projectRef}/envvars/${slug}`,
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "listEnvVars"),
      },
      this.#requestOptions("listEnvVars", requestOptions)
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
        headers: this.#getHeaders(false, undefined, "importEnvVars"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("importEnvVars", requestOptions)
    );
  }

  retrieveEnvVar(projectRef: string, slug: string, key: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      EnvironmentVariableWithSecret,
      `${this.baseUrl}/api/v1/projects/${projectRef}/envvars/${slug}/${key}`,
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "retrieveEnvVar"),
      },
      this.#requestOptions("retrieveEnvVar", requestOptions)
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
        headers: this.#getHeaders(false, undefined, "createEnvVar"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("createEnvVar", requestOptions)
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
        headers: this.#getHeaders(false, undefined, "updateEnvVar"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("updateEnvVar", requestOptions)
    );
  }

  deleteEnvVar(projectRef: string, slug: string, key: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      EnvironmentVariableResponseBody,
      `${this.baseUrl}/api/v1/projects/${projectRef}/envvars/${slug}/${key}`,
      {
        method: "DELETE",
        headers: this.#getHeaders(false, undefined, "deleteEnvVar"),
      },
      this.#requestOptions("deleteEnvVar", requestOptions)
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
        headers: this.#getHeaders(false, undefined, "updateRunMetadata"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("updateRunMetadata", requestOptions)
    );
  }

  getRunMetadata(runId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      UpdateMetadataResponseBody,
      `${this.baseUrl}/api/v1/runs/${runId}/metadata`,
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "getRunMetadata"),
      },
      this.#requestOptions("getRunMetadata", requestOptions)
    );
  }

  createWaitpointToken(options: CreateWaitpointTokenRequestBody, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      CreateWaitpointTokenResponseBody,
      `${this.baseUrl}/api/v1/waitpoints/tokens`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "createWaitpointToken"),
        body: JSON.stringify(options),
      },
      {
        ...this.#requestOptions("createWaitpointToken", requestOptions),
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
            secretKey: this.#selfSigningKey,
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
        headers: this.#getHeaders(false, undefined, "listWaitpointTokens"),
      },
      this.#requestOptions("listWaitpointTokens", requestOptions)
    );
  }

  retrieveWaitpointToken(friendlyId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      WaitpointRetrieveTokenResponse,
      `${this.baseUrl}/api/v1/waitpoints/tokens/${friendlyId}`,
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "retrieveWaitpointToken"),
      },
      this.#requestOptions("retrieveWaitpointToken", requestOptions)
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
        headers: this.#getHeaders(false, undefined, "completeWaitpointToken"),
        body: JSON.stringify(options),
      },
      {
        ...this.#requestOptions("completeWaitpointToken", requestOptions),
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
        headers: this.#getHeaders(false, undefined, "waitForWaitpointToken"),
      },
      this.#requestOptions("waitForWaitpointToken", requestOptions)
    );
  }

  // ========================================================================
  // Sessions
  // ========================================================================

  createSession(body: CreateSessionRequestBody, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      CreatedSessionResponseBody,
      `${this.baseUrl}/api/v1/sessions`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "createSession"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("createSession", requestOptions)
    );
  }

  retrieveSession(sessionIdOrExternalId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      RetrieveSessionResponseBody,
      `${this.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionIdOrExternalId)}`,
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "retrieveSession"),
      },
      this.#requestOptions("retrieveSession", requestOptions)
    );
  }

  updateSession(
    sessionIdOrExternalId: string,
    body: UpdateSessionRequestBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      RetrieveSessionResponseBody,
      `${this.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionIdOrExternalId)}`,
      {
        method: "PATCH",
        headers: this.#getHeaders(false, undefined, "updateSession"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("updateSession", requestOptions)
    );
  }

  closeSession(
    sessionIdOrExternalId: string,
    body?: CloseSessionRequestBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      RetrieveSessionResponseBody,
      `${this.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionIdOrExternalId)}/close`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "closeSession"),
        body: JSON.stringify(body ?? {}),
      },
      this.#requestOptions("closeSession", requestOptions)
    );
  }

  endAndContinueSession(
    sessionIdOrExternalId: string,
    body: EndAndContinueSessionRequestBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      EndAndContinueSessionResponseBody,
      `${this.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionIdOrExternalId)}/end-and-continue`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "endAndContinueSession"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("endAndContinueSession", requestOptions)
    );
  }

  listSessions(
    options?: ListSessionsOptions,
    requestOptions?: ZodFetchOptions
  ): CursorPagePromise<typeof ListedSessionItem> {
    const searchParams = createSearchQueryForListSessions(options);

    return zodfetchCursorPage(
      ListedSessionItem,
      `${this.baseUrl}/api/v1/sessions`,
      {
        query: searchParams,
        limit: options?.limit,
        after: options?.after,
        before: options?.before,
      },
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "listSessions"),
      },
      this.#requestOptions("listSessions", requestOptions)
    );
  }

  // ========================================================================
  // Session realtime channels
  // ========================================================================

  async initializeSessionStream(
    sessionIdOrExternalId: string,
    io: "out" | "in",
    requestOptions?: ZodFetchOptions,
    channel?: string
  ) {
    // The server returns S2 credentials in response headers alongside a tiny
    // JSON body with the realtime version. Follow the same shape as
    // `createStream` so downstream clients can feed them into
    // `StreamsWriterV2`.
    const base = `${this.baseUrl}/realtime/v1/sessions/${encodeURIComponent(sessionIdOrExternalId)}`;
    const url = channel ? `${base}/channels/${encodeURIComponent(channel)}/${io}` : `${base}/${io}`;
    return zodfetch(
      CreateStreamResponseBody,
      url,
      {
        method: "PUT",
        headers: this.#getHeaders(false, undefined, "initializeSessionStream"),
      },
      this.#requestOptions("initializeSessionStream", requestOptions)
    )
      .withResponse()
      .then(({ data, response }) => ({
        ...data,
        headers: Object.fromEntries(response.headers.entries()),
      }));
  }

  async appendToSessionStream<TBody extends BodyInit>(
    sessionIdOrExternalId: string,
    io: "out" | "in",
    part: TBody,
    requestOptions?: ZodFetchOptions,
    channel?: string
  ) {
    // Generated once per logical append, outside zodfetch, so its internal
    // retries reuse the same part id and the server-side dedupe collapses a
    // retried POST whose first attempt actually committed. Full-length nanoid
    // (~126 bits) to match the browser transport's randomUUID entropy.
    const partId = nanoid();
    const base = `${this.baseUrl}/realtime/v1/sessions/${encodeURIComponent(sessionIdOrExternalId)}`;
    const appendUrl = channel
      ? `${base}/channels/${encodeURIComponent(channel)}/${io}/append`
      : `${base}/${io}/append`;
    return zodfetch(
      AppendToStreamResponseBody,
      appendUrl,
      {
        method: "POST",
        headers: {
          ...this.#getHeaders(false, undefined, "appendToSessionStream"),
          "X-Part-Id": partId,
        },
        body: part,
      },
      this.#requestOptions("appendToSessionStream", requestOptions)
    );
  }

  /**
   * Non-SSE drain of a Session channel's tail. Returns whatever records
   * exist after `afterEventId` (or from the head of the stream) and closes
   * — `wait=0` semantics, no long-poll. Used by `replaySessionOutTail` at
   * run boot, where the SSE long-poll's ~1s tax on empty streams is the
   * dominant cost on every fresh chat.
   *
   * `afterEventId` is the same cursor format as the SSE Last-Event-ID
   * (the S2 sequence number, stringified) — pass `lastOutEventId` from a
   * persisted snapshot to resume.
   */
  async readSessionStreamRecords(
    sessionIdOrExternalId: string,
    io: "out" | "in",
    options?: { afterEventId?: string; baseUrl?: string; channel?: string }
  ) {
    const qs = new URLSearchParams();
    if (options?.afterEventId !== undefined) {
      qs.set("afterEventId", options.afterEventId);
    }
    const recordsBase = `${options?.baseUrl ?? this.baseUrl}/realtime/v1/sessions/${encodeURIComponent(
      sessionIdOrExternalId
    )}`;
    const recordsPath = options?.channel
      ? `${recordsBase}/channels/${encodeURIComponent(options.channel)}/${io}/records`
      : `${recordsBase}/${io}/records`;
    const url = `${recordsPath}${qs.toString() ? `?${qs.toString()}` : ""}`;
    return zodfetch(
      ReadSessionStreamRecordsResponseBody,
      url,
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "readSessionStreamRecords"),
      },
      this.#requestOptions("readSessionStreamRecords", undefined)
    );
  }

  /**
   * Subscribe to SSE records on a Session channel. Reuses the same
   * {@link SSEStreamSubscription} plumbing as `readStream` for run-scoped
   * realtime streams — auto-retry, Last-Event-ID resume, abort-on-cancel.
   */
  async subscribeToSessionStream<T = unknown>(
    sessionIdOrExternalId: string,
    io: "out" | "in",
    options?: {
      signal?: AbortSignal;
      baseUrl?: string;
      /**
       * A named side channel on the session. When omitted, the session's
       * reserved default channel (`session.in` / `session.out`) is used.
       */
      channel?: string;
      timeoutInSeconds?: number;
      onComplete?: () => void;
      onError?: (error: Error) => void;
      lastEventId?: string;
      /**
       * Where a fresh subscription (no `lastEventId`) starts reading. `"latest"`
       * starts at the current tail (only records after connect); `"beginning"`
       * (default) replays history.
       */
      from?: "beginning" | "latest";
      onPart?: (part: SSEStreamPart<T>) => void;
      /**
       * Fires when a `trigger-control` record arrives on the stream (e.g.
       * `turn-complete`, `upgrade-required`). The control record is never
       * enqueued into the consumer stream — handle the event here.
       */
      onControl?: (event: ControlEvent) => void;
    }
  ): Promise<AsyncIterableStream<T>> {
    const sessionSegment = `${options?.baseUrl ?? this.baseUrl}/realtime/v1/sessions/${encodeURIComponent(sessionIdOrExternalId)}`;
    const url = options?.channel
      ? `${sessionSegment}/channels/${encodeURIComponent(options.channel)}/${io}`
      : `${sessionSegment}/${io}`;

    const subscription = new SSEStreamSubscription(url, {
      headers: this.#getHeaders(false, undefined, "subscribeToSessionStream"),
      fetchClient: this.#requestFetch("subscribeToSessionStream"),
      resolveHeaders: this.#resolveStreamHeaders("subscribeToSessionStream"),
      signal: options?.signal,
      onComplete: options?.onComplete,
      onError: options?.onError,
      timeoutInSeconds: options?.timeoutInSeconds,
      lastEventId: options?.lastEventId,
      from: options?.from,
    });

    const stream = await subscription.subscribe();
    const onPart = options?.onPart;
    const onControl = options?.onControl;

    return stream.pipeThrough(
      new TransformStream<SSEStreamPart, T>({
        transform(part, controller) {
          // Always surface the raw part via onPart so cursor tracking
          // (lastSeqNum, lastEventId) stays correct for both data and
          // control records.
          onPart?.(part as SSEStreamPart<T>);

          // Trigger control record — route to onControl, never enqueue.
          const subtype = controlSubtype(part.headers);
          if (subtype) {
            // `part.id` is the S2 seq_num in decimal string form.
            // `parseInt` returns NaN if S2 ever surfaces a non-numeric
            // id (shouldn't happen, but `|| 0` would mask it as a real
            // seq 0). Drop the malformed event rather than fire
            // `onControl` with a misleading cursor — callers like
            // `findLatestSessionInCursor` and the dashboard rely on the
            // seqNum being meaningful for resume.
            const parsedSeqNum = Number.parseInt(part.id, 10);
            if (!Number.isFinite(parsedSeqNum)) {
              return;
            }
            onControl?.({
              subtype,
              headers: part.headers ?? [],
              seqNum: parsedSeqNum,
              timestamp: part.timestamp,
            });
            return;
          }

          controller.enqueue(part.chunk as T);
        },
      })
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
        headers: this.#getHeaders(false, undefined, "waitForDuration"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("waitForDuration", requestOptions)
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
        headers: this.#getHeaders(false, undefined, "listQueues"),
      },
      this.#requestOptions("listQueues", requestOptions)
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
        headers: this.#getHeaders(false, undefined, "retrieveQueue"),
      },
      this.#requestOptions("retrieveQueue", requestOptions)
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
        headers: this.#getHeaders(false, undefined, "pauseQueue"),
        body: JSON.stringify({
          type,
          action,
        }),
      },
      this.#requestOptions("pauseQueue", requestOptions)
    );
  }

  overrideQueueConcurrencyLimit(
    queue: RetrieveQueueParam,
    concurrencyLimit: number,
    requestOptions?: ZodFetchOptions
  ) {
    const type = typeof queue === "string" ? "id" : queue.type;
    const value = typeof queue === "string" ? queue : queue.name;

    // Explicitly encode slashes before encoding the rest of the string
    const encodedValue = encodeURIComponent(value.replace(/\//g, "%2F"));

    return zodfetch(
      QueueItem,
      `${this.baseUrl}/api/v1/queues/${encodedValue}/concurrency/override`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "overrideQueueConcurrencyLimit"),
        body: JSON.stringify({
          type,
          concurrencyLimit,
        }),
      },
      this.#requestOptions("overrideQueueConcurrencyLimit", requestOptions)
    );
  }

  resetQueueConcurrencyLimit(queue: RetrieveQueueParam, requestOptions?: ZodFetchOptions) {
    const type = typeof queue === "string" ? "id" : queue.type;
    const value = typeof queue === "string" ? queue : queue.name;

    // Explicitly encode slashes before encoding the rest of the string
    const encodedValue = encodeURIComponent(value.replace(/\//g, "%2F"));

    return zodfetch(
      QueueItem,
      `${this.baseUrl}/api/v1/queues/${encodedValue}/concurrency/reset`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "resetQueueConcurrencyLimit"),
        body: JSON.stringify({
          type,
        }),
      },
      this.#requestOptions("resetQueueConcurrencyLimit", requestOptions)
    );
  }

  listConcurrencyLimits(options?: ListConcurrencyLimitOptions, requestOptions?: ZodFetchOptions) {
    return zodfetchOffsetLimitPage(
      ConcurrencyLimitItem,
      `${this.baseUrl}/api/v1/concurrency-limits`,
      {
        page: options?.page,
        limit: options?.perPage,
      },
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "listConcurrencyLimits"),
      },
      this.#requestOptions("listConcurrencyLimits", requestOptions)
    );
  }

  retrieveConcurrencyLimit(name: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      ConcurrencyLimitItem,
      `${this.baseUrl}/api/v1/concurrency-limits/${encodeURIComponent(name)}`,
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "retrieveConcurrencyLimit"),
      },
      this.#requestOptions("retrieveConcurrencyLimit", requestOptions)
    );
  }

  retrieveConcurrencyLimitKey(
    name: string,
    concurrencyKey: string,
    requestOptions?: ZodFetchOptions
  ) {
    const query = new URLSearchParams({ concurrencyKey });
    return zodfetch(
      ConcurrencyLimitKeyItem,
      `${this.baseUrl}/api/v1/concurrency-limits/${encodeURIComponent(name)}?${query.toString()}`,
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "retrieveConcurrencyLimitKey"),
      },
      this.#requestOptions("retrieveConcurrencyLimitKey", requestOptions)
    );
  }

  overrideConcurrencyLimit(
    name: string,
    override: OverrideConcurrencyLimitBoundsBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      ConcurrencyLimitItem,
      `${this.baseUrl}/api/v1/concurrency-limits/${encodeURIComponent(name)}/override`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "overrideConcurrencyLimit"),
        body: JSON.stringify(override),
      },
      this.#requestOptions("overrideConcurrencyLimit", requestOptions)
    );
  }

  overrideConcurrencyLimitKey(
    name: string,
    override: OverrideConcurrencyLimitKeyBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      ConcurrencyLimitKeyItem,
      `${this.baseUrl}/api/v1/concurrency-limits/${encodeURIComponent(name)}/override`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "overrideConcurrencyLimitKey"),
        body: JSON.stringify(override),
      },
      this.#requestOptions("overrideConcurrencyLimitKey", requestOptions)
    );
  }

  pauseConcurrencyLimit(
    name: string,
    action: "pause" | "resume",
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      ConcurrencyLimitItem,
      `${this.baseUrl}/api/v1/concurrency-limits/${encodeURIComponent(name)}/pause`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "pauseConcurrencyLimit"),
        body: JSON.stringify({
          action,
        }),
      },
      this.#requestOptions("pauseConcurrencyLimit", requestOptions)
    );
  }

  resetConcurrencyLimit(name: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      ConcurrencyLimitItem,
      `${this.baseUrl}/api/v1/concurrency-limits/${encodeURIComponent(name)}/reset`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "resetConcurrencyLimit"),
        body: JSON.stringify({}),
      },
      this.#requestOptions("resetConcurrencyLimit", requestOptions)
    );
  }

  resetConcurrencyLimitKey(
    name: string,
    body: ResetConcurrencyLimitRequestBody & { concurrencyKey: string },
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      ConcurrencyLimitKeyItem,
      `${this.baseUrl}/api/v1/concurrency-limits/${encodeURIComponent(name)}/reset`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "resetConcurrencyLimitKey"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("resetConcurrencyLimitKey", requestOptions)
    );
  }

  subscribeToRun<TRunTypes extends AnyRunTypes>(
    runId: string,
    options?: {
      signal?: AbortSignal;
      closeOnComplete?: boolean;
      onFetchError?: (error: Error) => void;
      skipColumns?: string[];
      fetchClient?: typeof fetch;
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
        headers: this.#getRealtimeHeaders("subscribeToRun"),
        resolveHeaders: this.#resolveRealtimeHeaders("subscribeToRun"),
        client: this,
        signal: options?.signal,
        onFetchError: options?.onFetchError,
        fetchClient: this.#requestFetch("subscribeToRun", options?.fetchClient),
      }
    );
  }

  subscribeToRunsWithTag<TRunTypes extends AnyRunTypes>(
    tag: string | string[],
    filters?: { createdAt?: string; skipColumns?: string[] },
    options?: {
      signal?: AbortSignal;
      onFetchError?: (error: Error) => void;
      fetchClient?: typeof fetch;
    }
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
        headers: this.#getRealtimeHeaders("subscribeToRunsWithTag"),
        resolveHeaders: this.#resolveRealtimeHeaders("subscribeToRunsWithTag"),
        client: this,
        signal: options?.signal,
        onFetchError: options?.onFetchError,
        fetchClient: this.#requestFetch("subscribeToRunsWithTag", options?.fetchClient),
      }
    );
  }

  subscribeToBatch<TRunTypes extends AnyRunTypes>(
    batchId: string,
    options?: {
      signal?: AbortSignal;
      onFetchError?: (error: Error) => void;
      skipColumns?: string[];
      fetchClient?: typeof fetch;
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
        headers: this.#getRealtimeHeaders("subscribeToBatch"),
        resolveHeaders: this.#resolveRealtimeHeaders("subscribeToBatch"),
        client: this,
        signal: options?.signal,
        onFetchError: options?.onFetchError,
        fetchClient: this.#requestFetch("subscribeToBatch", options?.fetchClient),
      }
    );
  }

  listDeployments(options?: ApiDeploymentListOptions, requestOptions?: ZodFetchOptions) {
    const searchParams = new URLSearchParams();

    if (options?.status) {
      searchParams.append("status", options.status);
    }

    if (options?.period) {
      searchParams.append("period", options.period);
    }

    if (options?.from) {
      searchParams.append("from", options.from);
    }

    if (options?.to) {
      searchParams.append("to", options.to);
    }

    return zodfetchCursorPage(
      ApiDeploymentListResponseItem,
      `${this.baseUrl}/api/v1/deployments`,
      {
        query: searchParams,
        after: options?.cursor,
        limit: options?.limit,
      },
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "listDeployments"),
      },
      this.#requestOptions("listDeployments", requestOptions)
    );
  }

  retrieveCurrentDeployment(requestOptions?: ZodFetchOptions) {
    return zodfetch(
      RetrieveCurrentDeploymentResponseBody,
      `${this.baseUrl}/api/v1/deployments/current`,
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "retrieveCurrentDeployment"),
      },
      this.#requestOptions("retrieveCurrentDeployment", requestOptions)
    );
  }

  async fetchStream<T>(
    runId: string,
    streamKey: string,
    options?: {
      signal?: AbortSignal;
      baseUrl?: string;
      timeoutInSeconds?: number;
      onComplete?: () => void;
      onError?: (error: Error) => void;
      lastEventId?: string;
      /**
       * Where a fresh subscription (no `lastEventId`) starts reading. `"latest"`
       * starts at the current tail (only records after connect); `"beginning"`
       * (default) replays history.
       */
      from?: "beginning" | "latest";
      /** Called for each SSE event with the full event metadata (id, timestamp). */
      onPart?: (part: SSEStreamPart<T>) => void;
    }
  ): Promise<AsyncIterableStream<T>> {
    const streamFactory = new SSEStreamSubscriptionFactory(options?.baseUrl ?? this.baseUrl, {
      headers: this.#getHeaders(false, undefined, "fetchStream"),
      fetchClient: this.#requestFetch("fetchStream"),
      signal: options?.signal,
      resolveHeaders: this.#resolveStreamHeaders("fetchStream"),
    });

    const subscription = streamFactory.createSubscription(runId, streamKey, {
      onComplete: options?.onComplete,
      onError: options?.onError,
      timeoutInSeconds: options?.timeoutInSeconds,
      lastEventId: options?.lastEventId,
      from: options?.from,
    });

    const stream = await subscription.subscribe();

    const onPart = options?.onPart;

    return stream.pipeThrough(
      new TransformStream<SSEStreamPart, T>({
        transform(chunk, controller) {
          const data = chunk.chunk as T;
          onPart?.(chunk as SSEStreamPart<T>);
          controller.enqueue(data);
        },
      })
    );
  }

  async createStream(
    runId: string,
    target: string,
    streamId: string,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      CreateStreamResponseBody,
      `${this.baseUrl}/realtime/v1/streams/${runId}/${target}/${streamId}`,
      {
        method: "PUT",
        headers: this.#getHeaders(false, undefined, "createStream"),
      },
      this.#requestOptions("createStream", requestOptions)
    )
      .withResponse()
      .then(async ({ data, response }) => {
        return {
          ...data,
          headers: Object.fromEntries(response.headers.entries()),
        };
      });
  }

  async appendToStream<TBody extends BodyInit>(
    runId: string,
    target: string,
    streamId: string,
    part: TBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      AppendToStreamResponseBody,
      `${this.baseUrl}/realtime/v1/streams/${runId}/${target}/${streamId}/append`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "appendToStream"),
        body: part,
      },
      this.#requestOptions("appendToStream", requestOptions)
    );
  }

  async sendInputStream(
    runId: string,
    streamId: string,
    data: unknown,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      SendInputStreamResponseBody,
      `${this.baseUrl}/realtime/v1/streams/${runId}/input/${streamId}`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "sendInputStream"),
        body: JSON.stringify({ data }),
      },
      this.#requestOptions("sendInputStream", requestOptions)
    );
  }

  async createInputStreamWaitpoint(
    runFriendlyId: string,
    body: CreateInputStreamWaitpointRequestBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      CreateInputStreamWaitpointResponseBody,
      `${this.baseUrl}/api/v1/runs/${runFriendlyId}/input-streams/wait`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "createInputStreamWaitpoint"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("createInputStreamWaitpoint", requestOptions)
    );
  }

  async createSessionStreamWaitpoint(
    runFriendlyId: string,
    body: CreateSessionStreamWaitpointRequestBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      CreateSessionStreamWaitpointResponseBody,
      `${this.baseUrl}/api/v1/runs/${runFriendlyId}/session-streams/wait`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "createSessionStreamWaitpoint"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("createSessionStreamWaitpoint", requestOptions)
    );
  }

  async generateJWTClaims(requestOptions?: ZodFetchOptions): Promise<Record<string, any>> {
    return zodfetch(
      z.record(z.string(), z.any()),
      `${this.baseUrl}/api/v1/auth/jwt/claims`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "generateJWTClaims"),
      },
      this.#requestOptions("generateJWTClaims", requestOptions)
    );
  }

  async createPublicToken(
    body: CreatePublicTokenRequestBody,
    requestOptions?: ZodFetchOptions
  ): Promise<{ token: string }> {
    return zodfetch(
      CreatePublicTokenResponseBody,
      `${this.baseUrl}/api/v1/auth/public-tokens`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "createPublicToken"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("createPublicToken", requestOptions)
    );
  }

  retrieveBatch(batchId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      RetrieveBatchV2Response,
      `${this.baseUrl}/api/v2/batches/${batchId}`,
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "retrieveBatch"),
      },
      this.#requestOptions("retrieveBatch", requestOptions)
    );
  }

  async executeQuery(
    query: string,
    options?: {
      scope?: "environment" | "project" | "organization";
      period?: string;
      from?: string;
      to?: string;
      format?: "json" | "csv";
    },
    requestOptions?: ZodFetchOptions
  ): Promise<QueryExecuteResponseBody> {
    const operation =
      !options?.scope || options.scope === "environment"
        ? "executeQuery"
        : "executeQueryProjectOrOrganization";
    const body = {
      query,
      scope: options?.scope ?? "environment",
      period: options?.period,
      from: options?.from,
      to: options?.to,
      format: options?.format ?? "json",
    };

    return zodfetch(
      QueryExecuteResponseBody,
      `${this.baseUrl}/api/v1/query`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, operation),
        body: JSON.stringify(body),
      },
      this.#requestOptions(operation, requestOptions)
    );
  }

  async getQuerySchema(requestOptions?: ZodFetchOptions): Promise<QuerySchemaResponseBody> {
    return zodfetch(
      QuerySchemaResponseBody,
      `${this.baseUrl}/api/v1/query/schema`,
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "getQuerySchema"),
      },
      this.#requestOptions("getQuerySchema", requestOptions)
    );
  }

  async listDashboards(requestOptions?: ZodFetchOptions): Promise<ListDashboardsResponseBody> {
    return zodfetch(
      ListDashboardsResponseBody,
      `${this.baseUrl}/api/v1/query/dashboards`,
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "listDashboards"),
      },
      this.#requestOptions("listDashboards", requestOptions)
    );
  }

  retrieveDashboard(dashboardId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      DashboardObject,
      `${this.baseUrl}/api/v1/query/dashboards/${encodeURIComponent(dashboardId)}`,
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "retrieveDashboard"),
      },
      this.#requestOptions("retrieveDashboard", requestOptions)
    );
  }

  createDashboard(body: CreateDashboardRequestBody, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      DashboardObject,
      `${this.baseUrl}/api/v1/query/dashboards`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "createDashboard"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("createDashboard", requestOptions)
    );
  }

  updateDashboard(
    dashboardId: string,
    body: UpdateDashboardRequestBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      DashboardObject,
      `${this.baseUrl}/api/v1/query/dashboards/${encodeURIComponent(dashboardId)}`,
      {
        method: "PATCH",
        headers: this.#getHeaders(false, undefined, "updateDashboard"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("updateDashboard", requestOptions)
    );
  }

  replaceDashboard(
    dashboardId: string,
    body: ReplaceDashboardRequestBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      DashboardObject,
      `${this.baseUrl}/api/v1/query/dashboards/${encodeURIComponent(dashboardId)}`,
      {
        method: "PUT",
        headers: this.#getHeaders(false, undefined, "replaceDashboard"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("replaceDashboard", requestOptions)
    );
  }

  deleteDashboard(dashboardId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      DeleteDashboardResponseBody,
      `${this.baseUrl}/api/v1/query/dashboards/${encodeURIComponent(dashboardId)}`,
      {
        method: "DELETE",
        headers: this.#getHeaders(false, undefined, "deleteDashboard"),
      },
      this.#requestOptions("deleteDashboard", requestOptions)
    );
  }

  addDashboardWidget(
    dashboardId: string,
    body: AddDashboardWidgetRequestBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      AddDashboardWidgetResponseBody,
      `${this.baseUrl}/api/v1/query/dashboards/${encodeURIComponent(dashboardId)}/widgets`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "addDashboardWidget"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("addDashboardWidget", requestOptions)
    );
  }

  updateDashboardWidget(
    dashboardId: string,
    widgetId: string,
    body: UpdateDashboardWidgetRequestBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      DashboardObject,
      `${this.baseUrl}/api/v1/query/dashboards/${encodeURIComponent(dashboardId)}/widgets/${encodeURIComponent(widgetId)}`,
      {
        method: "PATCH",
        headers: this.#getHeaders(false, undefined, "updateDashboardWidget"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("updateDashboardWidget", requestOptions)
    );
  }

  deleteDashboardWidget(
    dashboardId: string,
    widgetId: string,
    options?: { revision?: string },
    requestOptions?: ZodFetchOptions
  ) {
    const search = options?.revision
      ? `?${new URLSearchParams({ revision: options.revision }).toString()}`
      : "";

    return zodfetch(
      DashboardObject,
      `${this.baseUrl}/api/v1/query/dashboards/${encodeURIComponent(dashboardId)}/widgets/${encodeURIComponent(widgetId)}${search}`,
      {
        method: "DELETE",
        headers: this.#getHeaders(false, undefined, "deleteDashboardWidget"),
      },
      this.#requestOptions("deleteDashboardWidget", requestOptions)
    );
  }

  /**
   * `format: "json"` returns a `ReportViewModel`; "markdown" (default) and "ansi" return a rendered
   * string. `period` is a shorthand like "1h" or "7d", capped at 90d. Seconds are not accepted.
   */
  async getReport(
    key: string,
    options: { period?: string; format: "json" }
  ): Promise<ReportViewModel>;
  async getReport(
    key: string,
    options?: { period?: string; format?: "markdown" | "ansi" }
  ): Promise<string>;
  async getReport(
    key: string,
    options?: { period?: string; format?: ReportFormat }
  ): Promise<string | ReportViewModel> {
    const searchParams = new URLSearchParams({ format: options?.format ?? "markdown" });
    if (options?.period) {
      searchParams.set("period", options.period);
    }

    const response = await fetch(
      `${this.baseUrl}/api/v1/reports/${encodeURIComponent(key)}?${searchParams.toString()}`,
      {
        method: "GET",
        headers: this.#getHeaders(false, undefined, "getReport", true),
      }
    );

    if (!response.ok) {
      const bodySnippet = await readBodySnippet(response);
      throw new Error(
        `Failed to fetch report "${key}": ${response.status} ${response.statusText}${
          bodySnippet ? ` — ${bodySnippet}` : ""
        }`
      );
    }

    if (options?.format === "json") {
      return ReportViewModelSchema.parse(await response.json());
    }

    return response.text();
  }

  #getHeaders(
    spanParentAsLink: boolean,
    additionalHeaders?: Record<string, string | undefined>,
    operation = "unknown",
    recordSelection = false
  ) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(additionalHeaders?.Authorization
        ? { Authorization: additionalHeaders.Authorization }
        : this.getAuthenticationHeaders(operation, recordSelection)),
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

    if (this.additionalHeaders) {
      for (const [key, value] of Object.entries(this.additionalHeaders)) {
        if (!(key in headers)) {
          headers[key] = value;
        }
      }
    }

    if (!headers["x-trigger-source"]) {
      headers["x-trigger-source"] = "sdk";
    }

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

    const streamFlag = this.futureFlags.v2RealtimeStreams ?? true;

    if (
      streamFlag === false ||
      getEnvVar("TRIGGER_V2_REALTIME_STREAMS") === "0" ||
      getEnvVar("TRIGGER_V2_REALTIME_STREAMS") === "false" ||
      getEnvVar("TRIGGER_REALTIME_STREAMS_V2") === "0" ||
      getEnvVar("TRIGGER_REALTIME_STREAMS_V2") === "false"
    ) {
      headers["x-trigger-realtime-streams-version"] = "v1";
    } else {
      headers["x-trigger-realtime-streams-version"] = "v2";
    }

    return headers;
  }

  resolvePrompt(slug: string, body: ResolvePromptRequestBody, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      ResolvePromptResponseBody,
      `${this.baseUrl}/api/v1/prompts/${slug}`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "resolvePrompt"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("resolvePrompt", requestOptions)
    );
  }

  createWebhookWaiter(
    endpointId: string,
    body: CreateWebhookWaiterRequestBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      CreateWebhookWaiterResponseBody,
      `${this.baseUrl}/api/v1/webhooks/endpoints/${encodeURIComponent(endpointId)}/waiters`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "createWebhookWaiter"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("createWebhookWaiter", requestOptions)
    );
  }

  cancelWebhookWaiter(waiterId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      CancelWebhookWaiterResponseBody,
      `${this.baseUrl}/api/v1/webhooks/waiters/${encodeURIComponent(waiterId)}/cancel`,
      { method: "POST", headers: this.#getHeaders(false, undefined, "cancelWebhookWaiter") },
      this.#requestOptions("cancelWebhookWaiter", requestOptions)
    );
  }

  listWebhookEndpoints(requestOptions?: ZodFetchOptions) {
    return zodfetch(
      ListWebhookEndpointsResponse,
      `${this.baseUrl}/api/v1/webhooks/endpoints`,
      { method: "GET", headers: this.#getHeaders(false, undefined, "listWebhookEndpoints") },
      this.#requestOptions("listWebhookEndpoints", requestOptions)
    );
  }

  retrieveWebhookEndpoint(endpointId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      WebhookEndpointDetailObject,
      `${this.baseUrl}/api/v1/webhooks/endpoints/${encodeURIComponent(endpointId)}`,
      { method: "GET", headers: this.#getHeaders(false, undefined, "retrieveWebhookEndpoint") },
      this.#requestOptions("retrieveWebhookEndpoint", requestOptions)
    );
  }

  generateWebhookEndpointSecret(
    endpointId: string,
    body: RotateWebhookEndpointSecretRequestBody = {},
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      RotateWebhookEndpointSecretResponse,
      `${this.baseUrl}/api/v1/webhooks/endpoints/${encodeURIComponent(endpointId)}/rotate-secret`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "generateWebhookEndpointSecret"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("generateWebhookEndpointSecret", requestOptions)
    );
  }

  setWebhookEndpointSecret(
    endpointId: string,
    body: SetWebhookEndpointSecretRequestBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      SetWebhookEndpointSecretResponse,
      `${this.baseUrl}/api/v1/webhooks/endpoints/${encodeURIComponent(endpointId)}/secret`,
      {
        method: "PUT",
        headers: this.#getHeaders(false, undefined, "setWebhookEndpointSecret"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("setWebhookEndpointSecret", requestOptions)
    );
  }

  listWebhookDeliveries(query: ListWebhookDeliveriesQuery = {}, requestOptions?: ZodFetchOptions) {
    const searchParams = new URLSearchParams();
    const list = (value: string | string[] | undefined) =>
      value === undefined ? undefined : Array.isArray(value) ? value.join(",") : value;
    const endpoint = list(query.endpoint);
    if (endpoint) searchParams.set("filter[endpoint]", endpoint);
    const status = list(query.status);
    if (status) searchParams.set("filter[status]", status);
    if (query.period) searchParams.set("filter[period]", query.period);
    if (query.from) searchParams.set("filter[from]", query.from.toISOString());
    if (query.to) searchParams.set("filter[to]", query.to.toISOString());
    if (query.limit !== undefined) searchParams.set("page[size]", String(query.limit));
    if (query.after) searchParams.set("page[after]", query.after);
    const qs = searchParams.toString();

    return zodfetch(
      ListWebhookDeliveriesResponse,
      `${this.baseUrl}/api/v1/webhooks/deliveries${qs ? `?${qs}` : ""}`,
      { method: "GET", headers: this.#getHeaders(false, undefined, "listWebhookDeliveries") },
      this.#requestOptions("listWebhookDeliveries", requestOptions)
    );
  }

  retrieveWebhookDelivery(deliveryId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      WebhookDeliveryObject,
      `${this.baseUrl}/api/v1/webhooks/deliveries/${encodeURIComponent(deliveryId)}`,
      { method: "GET", headers: this.#getHeaders(false, undefined, "retrieveWebhookDelivery") },
      this.#requestOptions("retrieveWebhookDelivery", requestOptions)
    );
  }

  /** Replay to every subscriber (re-checking filters), or to one `targetId` past its filter. */
  replayWebhookDelivery(
    deliveryId: string,
    options: { targetId?: string } = {},
    requestOptions?: ZodFetchOptions
  ) {
    const qs = options.targetId ? `?targetId=${encodeURIComponent(options.targetId)}` : "";
    return zodfetch(
      ReplayWebhookDeliveryResponse,
      `${this.baseUrl}/api/v1/webhooks/deliveries/${encodeURIComponent(deliveryId)}/replay${qs}`,
      { method: "POST", headers: this.#getHeaders(false, undefined, "replayWebhookDelivery") },
      this.#requestOptions("replayWebhookDelivery", requestOptions)
    );
  }

  listPrompts(requestOptions?: ZodFetchOptions) {
    return zodfetch(
      ListPromptsResponseBody,
      `${this.baseUrl}/api/v1/prompts`,
      { method: "GET", headers: this.#getHeaders(false, undefined, "listPrompts") },
      this.#requestOptions("listPrompts", requestOptions)
    );
  }

  listPromptVersions(slug: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      ListPromptVersionsResponseBody,
      `${this.baseUrl}/api/v1/prompts/${slug}/versions`,
      { method: "GET", headers: this.#getHeaders(false, undefined, "listPromptVersions") },
      this.#requestOptions("listPromptVersions", requestOptions)
    );
  }

  promotePromptVersion(
    slug: string,
    body: PromotePromptVersionRequestBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      PromptOkResponseBody,
      `${this.baseUrl}/api/v1/prompts/${slug}/promote`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "promotePromptVersion"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("promotePromptVersion", requestOptions)
    );
  }

  createPromptOverride(
    slug: string,
    body: CreatePromptOverrideRequestBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      PromptOverrideCreatedResponseBody,
      `${this.baseUrl}/api/v1/prompts/${slug}/override`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "createPromptOverride"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("createPromptOverride", requestOptions)
    );
  }

  updatePromptOverride(
    slug: string,
    body: UpdatePromptOverrideRequestBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      PromptOkResponseBody,
      `${this.baseUrl}/api/v1/prompts/${slug}/override`,
      {
        method: "PUT",
        headers: this.#getHeaders(false, undefined, "updatePromptOverride"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("updatePromptOverride", requestOptions)
    );
  }

  removePromptOverride(slug: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      PromptOkResponseBody,
      `${this.baseUrl}/api/v1/prompts/${slug}/override`,
      { method: "DELETE", headers: this.#getHeaders(false, undefined, "removePromptOverride") },
      this.#requestOptions("removePromptOverride", requestOptions)
    );
  }

  reactivatePromptOverride(
    slug: string,
    body: ReactivatePromptOverrideRequestBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      PromptOkResponseBody,
      `${this.baseUrl}/api/v1/prompts/${slug}/override/reactivate`,
      {
        method: "POST",
        headers: this.#getHeaders(false, undefined, "reactivatePromptOverride"),
        body: JSON.stringify(body),
      },
      this.#requestOptions("reactivatePromptOverride", requestOptions)
    );
  }

  #getRealtimeHeaders(operation = "unknown") {
    let headers: Record<string, string> = {
      Authorization: `Bearer ${this.getAccessToken(operation)}`,
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

    if (query.machine) {
      searchParams.append(
        "filter[machine]",
        Array.isArray(query.machine) ? query.machine.join(",") : query.machine
      );
    }

    if (query.region) {
      searchParams.append(
        "filter[region]",
        Array.isArray(query.region) ? query.region.join(",") : query.region
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

function createSearchQueryForListSessions(options?: ListSessionsOptions): URLSearchParams {
  const searchParams = new URLSearchParams();

  if (!options) return searchParams;

  const appendMany = (name: string, value: string | string[] | undefined) => {
    if (value === undefined) return;
    searchParams.append(name, Array.isArray(value) ? value.join(",") : value);
  };

  appendMany("filter[type]", options.type);
  appendMany("filter[tags]", options.tag);
  appendMany("filter[taskIdentifier]", options.taskIdentifier);

  if (options.externalId) {
    searchParams.append("filter[externalId]", options.externalId);
  }

  appendMany("filter[status]", options.status as string | string[] | undefined);

  if (options.period) {
    searchParams.append("filter[createdAt][period]", options.period);
  }

  if (options.from !== undefined) {
    searchParams.append(
      "filter[createdAt][from]",
      options.from instanceof Date ? options.from.getTime().toString() : options.from.toString()
    );
  }

  if (options.to !== undefined) {
    searchParams.append(
      "filter[createdAt][to]",
      options.to instanceof Date ? options.to.getTime().toString() : options.to.toString()
    );
  }

  return searchParams;
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

// ============================================================================
// Stream Batch Items Retry Helpers
// ============================================================================

/**
 * Default retry options for streaming batch items.
 * Uses higher values than the default zodfetch retry since batch operations
 * are more expensive to repeat from scratch.
 */
const DEFAULT_STREAM_BATCH_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 5,
  factor: 2,
  minTimeoutInMs: 1000,
  maxTimeoutInMs: 30_000,
  randomize: true,
};

type ShouldRetryResult = { retry: false } | { retry: true; delay: number };

/**
 * Determines if a failed stream batch items request should be retried.
 * Follows similar logic to zodfetch's shouldRetry but specific to batch streaming.
 */
function shouldRetryStreamBatchItems(
  response: Response,
  attempt: number,
  retryOptions: RetryOptions
): ShouldRetryResult {
  function shouldRetryForOptions(): ShouldRetryResult {
    const delay = calculateNextRetryDelay(retryOptions, attempt);
    if (delay) {
      return { retry: true, delay };
    }
    return { retry: false };
  }

  // Check x-should-retry header - server can explicitly control retry behavior
  const shouldRetryHeader = response.headers.get("x-should-retry");
  if (shouldRetryHeader === "true") return shouldRetryForOptions();
  if (shouldRetryHeader === "false") return { retry: false };

  // Retry on request timeouts
  if (response.status === 408) return shouldRetryForOptions();

  // Retry on lock timeouts
  if (response.status === 409) return shouldRetryForOptions();

  // Retry on rate limits with special handling for Retry-After
  if (response.status === 429) {
    if (attempt >= retryOptions.maxAttempts!) {
      return { retry: false };
    }

    // x-ratelimit-reset is the unix timestamp in milliseconds when the rate limit will reset
    const resetAtUnixEpochMs = response.headers.get("x-ratelimit-reset");
    if (resetAtUnixEpochMs) {
      const resetAtUnixEpoch = parseInt(resetAtUnixEpochMs, 10);
      const delay = resetAtUnixEpoch - Date.now() + Math.floor(Math.random() * 1000);
      if (delay > 0) {
        return { retry: true, delay };
      }
    }

    // Fall back to Retry-After header (seconds)
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const retryAfterSeconds = parseInt(retryAfter, 10);
      if (!isNaN(retryAfterSeconds)) {
        return { retry: true, delay: retryAfterSeconds * 1000 };
      }
    }

    return shouldRetryForOptions();
  }

  // Retry on server errors (5xx)
  if (response.status >= 500) return shouldRetryForOptions();

  // Don't retry client errors (4xx) except those handled above
  return { retry: false };
}

/**
 * Simple sleep utility for retry delays.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serializes a replay payload override with SuperJSON, like `trigger()` does, so values such
 * as `Date` and `BigInt` reach the task intact. Falls back to plain JSON when SuperJSON can't
 * serialize the value.
 */
function withSuperJsonPayload(body: ReplayRunRequestBody): ReplayRunRequestBody {
  if (body.payload === undefined || body.payloadType !== undefined) {
    return body;
  }

  try {
    return {
      ...body,
      payload: superjson.stringify(body.payload),
      payloadType: "application/super+json",
    };
  } catch {
    return body;
  }
}

/**
 * Best-effort read of a (likely error) response body for inclusion in a thrown Error.
 * Never throws, and truncates so we don't dump a huge HTML page into an error message.
 */
async function readBodySnippet(response: Response, maxLength = 500): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text) {
      return "";
    }
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  } catch {
    return "";
  }
}

/**
 * Safely cancels a ReadableStream, handling the case where it might be locked.
 *
 * When fetch uses a ReadableStream as a request body and an error occurs mid-transfer
 * (connection reset, timeout, etc.), the stream may remain locked by fetch's internal reader.
 * Attempting to cancel a locked stream throws "Invalid state: ReadableStream is locked".
 *
 * This function gracefully handles that case by catching the error and doing nothing -
 * the stream will be cleaned up by garbage collection when the reader is released.
 */
async function safeStreamCancel(stream: ReadableStream<unknown>): Promise<void> {
  try {
    await stream.cancel();
  } catch (error) {
    // Ignore "locked" errors - the stream will be cleaned up when the reader is released.
    // This happens when fetch crashes mid-read and doesn't release the reader lock.
    if (error instanceof TypeError && String(error).includes("locked")) {
      return;
    }
    // Re-throw unexpected errors
    throw error;
  }
}

// ============================================================================
// NDJSON Stream Helpers
// ============================================================================

/**
 * Creates a ReadableStream that emits NDJSON (newline-delimited JSON) from items.
 * Handles both arrays and async iterables for streaming large batches.
 */
function createNdjsonStream(
  items: BatchItemNDJSON[] | AsyncIterable<BatchItemNDJSON>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  // Check if items is an array
  if (Array.isArray(items)) {
    let index = 0;
    return new ReadableStream({
      pull(controller) {
        if (index >= items.length) {
          controller.close();
          return;
        }

        const item = items[index++];
        const line = JSON.stringify(item) + "\n";
        controller.enqueue(encoder.encode(line));
      },
    });
  }

  // Handle async iterable
  const iterator = items[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await iterator.next();

      if (done) {
        controller.close();
        return;
      }

      const line = JSON.stringify(value) + "\n";
      controller.enqueue(encoder.encode(line));
    },
  });
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
