import type {
  AnyRetrieveRunResult,
  AnyRunShape,
  ApiRequestOptions,
  InferRunTypes,
  ListProjectRunsQueryParams,
  ListRunsQueryParams,
  RescheduleRunRequestBody,
  RetrieveRunResult,
  RunShape,
  RealtimeRun,
  AnyRealtimeRun,
  RunSubscription,
  TaskRunShape,
  AnyBatchedRunHandle,
  AsyncIterableStream,
  ApiPromise,
  RealtimeRunSkipColumns,
} from "@trigger.dev/core/v3";
import {
  CanceledRunResponse,
  CursorPagePromise,
  ListRunResponseItem,
  ReplayRunResponse,
  RetrieveRunResponse,
  accessoryAttributes,
  apiClientManager,
  flattenAttributes,
  isRequestOptions,
  mergeRequestOptions,
} from "@trigger.dev/core/v3";
import { resolvePresignedPacketUrl } from "@trigger.dev/core/v3/utils/ioSerialization";
import { AnyRunHandle, AnyTask } from "./shared.js";
import { tracer } from "./tracer.js";

export type {
  AnyRetrieveRunResult,
  AnyRunShape,
  RetrieveRunResult,
  RunShape,
  TaskRunShape,
  RealtimeRun,
  AnyRealtimeRun,
};

export const runs = {
  replay: replayRun,
  cancel: cancelRun,
  retrieve: retrieveRun,
  list: listRuns,
  reschedule: rescheduleRun,
  poll,
  subscribeToRun,
  subscribeToRunsWithTag,
  subscribeToBatch: subscribeToRunsInBatch,
  fetchStream,
};

export type ListRunsItem = ListRunResponseItem;

function listRuns(
  projectRef: string,
  params?: ListProjectRunsQueryParams,
  requestOptions?: ApiRequestOptions
): CursorPagePromise<typeof ListRunResponseItem>;
function listRuns(
  params?: ListRunsQueryParams,
  requestOptions?: ApiRequestOptions
): CursorPagePromise<typeof ListRunResponseItem>;
function listRuns(
  paramsOrProjectRef?: ListRunsQueryParams | string,
  paramsOrOptions?: ListRunsQueryParams | ListProjectRunsQueryParams | ApiRequestOptions,
  requestOptions?: ApiRequestOptions
): CursorPagePromise<typeof ListRunResponseItem> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = listRunsRequestOptions(
    paramsOrProjectRef,
    paramsOrOptions,
    requestOptions
  );

  if (typeof paramsOrProjectRef === "string") {
    if (isRequestOptions(paramsOrOptions)) {
      return apiClient.listProjectRuns(paramsOrProjectRef, {}, $requestOptions);
    } else {
      return apiClient.listProjectRuns(paramsOrProjectRef, paramsOrOptions, $requestOptions);
    }
  }

  return apiClient.listRuns(paramsOrProjectRef, $requestOptions);
}

function listRunsRequestOptions(
  paramsOrProjectRef?: ListRunsQueryParams | string,
  paramsOrOptions?: ListRunsQueryParams | ListProjectRunsQueryParams | ApiRequestOptions,
  requestOptions?: ApiRequestOptions
): ApiRequestOptions {
  if (typeof paramsOrProjectRef === "string") {
    if (isRequestOptions(paramsOrOptions)) {
      return mergeRequestOptions(
        {
          tracer,
          name: "runs.list()",
          icon: "runs",
          attributes: {
            projectRef: paramsOrProjectRef,
            ...accessoryAttributes({
              items: [
                {
                  text: paramsOrProjectRef,
                  variant: "normal",
                },
              ],
              style: "codepath",
            }),
          },
        },
        paramsOrOptions
      );
    } else {
      return mergeRequestOptions(
        {
          tracer,
          name: "runs.list()",
          icon: "runs",
          attributes: {
            projectRef: paramsOrProjectRef,
            ...flattenAttributes(paramsOrOptions as Record<string, unknown>, "queryParams"),
            ...accessoryAttributes({
              items: [
                {
                  text: paramsOrProjectRef,
                  variant: "normal",
                },
              ],
              style: "codepath",
            }),
          },
        },
        requestOptions
      );
    }
  }

  return mergeRequestOptions(
    {
      tracer,
      name: "runs.list()",
      icon: "runs",
      attributes: {
        ...flattenAttributes(paramsOrProjectRef as Record<string, unknown>, "queryParams"),
      },
    },
    isRequestOptions(paramsOrOptions) ? paramsOrOptions : requestOptions
  );
}

// Extract out the expected type of the id, can be either a string or a RunHandle
type RunId<TRunId> = TRunId extends AnyRunHandle | AnyBatchedRunHandle
  ? TRunId
  : TRunId extends AnyTask
  ? string
  : TRunId extends string
  ? TRunId
  : never;

function retrieveRun<TRunId extends AnyRunHandle | AnyBatchedRunHandle | AnyTask | string>(
  runId: RunId<TRunId>,
  requestOptions?: ApiRequestOptions
): ApiPromise<RetrieveRunResult<TRunId>> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "runs.retrieve()",
      icon: "runs",
      attributes: {
        runId: typeof runId === "string" ? runId : runId.id,
        ...accessoryAttributes({
          items: [
            {
              text: typeof runId === "string" ? runId : runId.id,
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
      },
      prepareData: resolvePayloadAndOutputUrls,
    },
    requestOptions
  );

  const $runId = typeof runId === "string" ? runId : runId.id;

  return apiClient.retrieveRun($runId, $requestOptions) as ApiPromise<RetrieveRunResult<TRunId>>;
}

async function resolvePayloadAndOutputUrls(run: AnyRetrieveRunResult) {
  const resolvedRun = { ...run };

  if (run.payloadPresignedUrl && run.outputPresignedUrl) {
    const [payload, output] = await Promise.all([
      resolvePresignedPacketUrl(run.payloadPresignedUrl, tracer),
      resolvePresignedPacketUrl(run.outputPresignedUrl, tracer),
    ]);

    resolvedRun.payload = payload;
    resolvedRun.output = output;
  } else if (run.payloadPresignedUrl) {
    resolvedRun.payload = await resolvePresignedPacketUrl(run.payloadPresignedUrl, tracer);
  } else if (run.outputPresignedUrl) {
    resolvedRun.output = await resolvePresignedPacketUrl(run.outputPresignedUrl, tracer);
  }

  return resolvedRun;
}

function replayRun(
  runId: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<ReplayRunResponse> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "runs.replay()",
      icon: "runs",
      attributes: {
        runId,
        ...accessoryAttributes({
          items: [
            {
              text: runId,
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
      },
    },
    requestOptions
  );

  return apiClient.replayRun(runId, $requestOptions);
}

function cancelRun(
  runId: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<CanceledRunResponse> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "runs.cancel()",
      icon: "runs",
      attributes: {
        runId,
        ...accessoryAttributes({
          items: [
            {
              text: runId,
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
      },
    },
    requestOptions
  );

  return apiClient.cancelRun(runId, $requestOptions);
}

function rescheduleRun(
  runId: string,
  body: RescheduleRunRequestBody,
  requestOptions?: ApiRequestOptions
): ApiPromise<RetrieveRunResponse> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "runs.reschedule()",
      icon: "runs",
      attributes: {
        runId,
        ...accessoryAttributes({
          items: [
            {
              text: runId,
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
      },
    },
    requestOptions
  );

  return apiClient.rescheduleRun(runId, body, $requestOptions);
}

export type PollOptions = { pollIntervalMs?: number };

const MAX_POLL_ATTEMPTS = 500;

async function poll<TRunId extends AnyRunHandle | AnyTask | string>(
  runId: RunId<TRunId>,
  options?: { pollIntervalMs?: number },
  requestOptions?: ApiRequestOptions
) {
  let attempts = 0;

  while (attempts++ < MAX_POLL_ATTEMPTS) {
    const run = await runs.retrieve(runId, requestOptions);

    if (run.isCompleted) {
      return run;
    }

    await new Promise((resolve) => setTimeout(resolve, options?.pollIntervalMs ?? 1000));
  }

  throw new Error(
    `Run ${
      typeof runId === "string" ? runId : runId.id
    } did not complete after ${MAX_POLL_ATTEMPTS} attempts`
  );
}

export type SubscribeToRunOptions = {
  /**
   * Whether to close the subscription when the run completes
   *
   * @default true
   *
   * Set this to false if you are making updates to the run metadata after completion through child runs
   */
  stopOnCompletion?: boolean;

  /**
   * Skip columns from the subscription.
   *
   * @default []
   *
   * @example
   * ```ts
   * runs.subscribeToRun("123", { skipColumns: ["payload", "output"] });
   * ```
   */
  skipColumns?: RealtimeRunSkipColumns;
};

/**
 * Subscribes to real-time updates for a specific run.
 *
 * This function allows you to receive real-time updates whenever a run changes, including:
 * - Status changes in the run lifecycle
 * - Tag additions or removals
 * - Metadata updates
 *
 * @template TRunId - The type parameter extending AnyRunHandle, AnyTask, or string
 * @param {RunId<TRunId>} runId - The ID of the run to subscribe to. Can be a string ID, RunHandle, or Task
 * @param {SubscribeToRunOptions} [options] - Optional configuration for the subscription
 * @param {boolean} [options.stopOnCompletion=true] - Whether to close the subscription when the run completes
 * @returns {RunSubscription<InferRunTypes<TRunId>>} An async iterator that yields updated run objects
 *
 * @example
 * ```ts
 * // Subscribe using a run handle
 * const handle = await tasks.trigger("my-task", { some: "data" });
 * for await (const run of runs.subscribeToRun(handle.id)) {
 *   console.log("Run updated:", run);
 * }
 *
 * // Subscribe with type safety
 * for await (const run of runs.subscribeToRun<typeof myTask>(runId)) {
 *   console.log("Payload:", run.payload.some);
 *   if (run.output) {
 *     console.log("Output:", run.output);
 *   }
 * }
 * ```
 */
function subscribeToRun<TRunId extends AnyRunHandle | AnyTask | string>(
  runId: RunId<TRunId>,
  options?: SubscribeToRunOptions
): RunSubscription<InferRunTypes<TRunId>> {
  const $runId = typeof runId === "string" ? runId : runId.id;

  const apiClient = apiClientManager.clientOrThrow();

  return apiClient.subscribeToRun($runId, {
    closeOnComplete:
      typeof options?.stopOnCompletion === "boolean" ? options.stopOnCompletion : true,
    skipColumns: options?.skipColumns,
  });
}

export type SubscribeToRunsFilterOptions = {
  /**
   * Filter runs by the time they were created. You must specify the duration string like "1h", "10s", "30m", etc.
   *
   * @example
   * "1h" - 1 hour ago
   * "10s" - 10 seconds ago
   * "30m" - 30 minutes ago
   * "1d" - 1 day ago
   * "1w" - 1 week ago
   *
   * The maximum duration is 1 week
   *
   * @note The timestamp will be calculated on the server side when you first subscribe to the runs.
   *
   */
  createdAt?: string;

  /**
   * Skip columns from the subscription.
   *
   * @default []
   */
  skipColumns?: RealtimeRunSkipColumns;
};

/**
 * Subscribes to real-time updates for all runs that have specific tags.
 *
 * This function allows you to monitor multiple runs simultaneously by filtering on tags.
 * You'll receive updates whenever any run with the specified tag(s) changes.
 *
 * @template TTasks - The type parameter extending AnyTask for type-safe payload and output
 * @param {string | string[]} tag - A single tag or array of tags to filter runs
 * @returns {RunSubscription<InferRunTypes<TTasks>>} An async iterator that yields updated run objects
 *
 * @example
 * ```ts
 * // Subscribe to runs with a single tag
 * for await (const run of runs.subscribeToRunsWithTag("user:1234")) {
 *   console.log("Run updated:", run);
 * }
 *
 * // Subscribe with multiple tags and type safety
 * for await (const run of runs.subscribeToRunsWithTag<typeof myTask | typeof otherTask>(["tag1", "tag2"])) {
 *   switch (run.taskIdentifier) {
 *     case "my-task":
 *       console.log("MyTask output:", run.output.foo);
 *       break;
 *     case "other-task":
 *       console.log("OtherTask output:", run.output.bar);
 *       break;
 *   }
 * }
 * ```
 */
function subscribeToRunsWithTag<TTasks extends AnyTask>(
  tag: string | string[],
  filters?: SubscribeToRunsFilterOptions,
  options?: { signal?: AbortSignal }
): RunSubscription<InferRunTypes<TTasks>> {
  const apiClient = apiClientManager.clientOrThrow();

  return apiClient.subscribeToRunsWithTag<InferRunTypes<TTasks>>(tag, filters, {
    ...(options ? { signal: options.signal } : {}),
  });
}

/**
 * Subscribes to real-time updates for all runs within a specific batch.
 *
 * Use this function when you've triggered multiple runs using `batchTrigger` and want
 * to monitor all runs in that batch. You'll receive updates whenever any run in the batch changes.
 *
 * @template TTasks - The type parameter extending AnyTask for type-safe payload and output
 * @param {string} batchId - The ID of the batch to subscribe to
 * @returns {RunSubscription<InferRunTypes<TTasks>>} An async iterator that yields updated run objects
 *
 * @example
 * ```ts
 * // Subscribe to all runs in a batch
 * for await (const run of runs.subscribeToRunsInBatch("batch-123")) {
 *   console.log("Batch run updated:", run);
 * }
 *
 * // Subscribe with type safety
 * for await (const run of runs.subscribeToRunsInBatch<typeof myTask>("batch-123")) {
 *   console.log("Run payload:", run.payload);
 *   if (run.output) {
 *     console.log("Run output:", run.output);
 *   }
 * }
 * ```
 *
 * @note The run objects received will include standard fields like id, status, payload, output,
 * createdAt, updatedAt, tags, and more. See the Run object documentation for full details.
 */
function subscribeToRunsInBatch<TTasks extends AnyTask>(
  batchId: string
): RunSubscription<InferRunTypes<TTasks>> {
  const apiClient = apiClientManager.clientOrThrow();

  return apiClient.subscribeToBatch<InferRunTypes<TTasks>>(batchId);
}

/**
 * Fetches a stream of data from a run's stream key.
 */
async function fetchStream<T>(runId: string, streamKey: string): Promise<AsyncIterableStream<T>> {
  const apiClient = apiClientManager.clientOrThrow();

  return await apiClient.fetchStream(runId, streamKey);
}
