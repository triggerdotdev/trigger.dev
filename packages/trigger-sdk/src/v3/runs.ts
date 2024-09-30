import type {
  ApiRequestOptions,
  ListProjectRunsQueryParams,
  ListRunsQueryParams,
  RescheduleRunRequestBody,
  RunShape,
  RunStreamCallback,
  RunSubscription,
} from "@trigger.dev/core/v3";
import {
  ApiPromise,
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
import { AnyRunHandle, AnyTask, Prettify, RunHandle, Task } from "./shared.js";
import { tracer } from "./tracer.js";

export type RetrieveRunResult<TPayload = any, TOutput = any> = Prettify<
  Omit<RetrieveRunResponse, "output" | "payload"> & {
    output?: TOutput;
    payload?: TPayload;
  }
>;

export const runs = {
  replay: replayRun,
  cancel: cancelRun,
  retrieve: retrieveRun,
  list: listRuns,
  reschedule: rescheduleRun,
  poll,
  subscribe: subscribeToRun,
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
type RunId<TRunId> = TRunId extends AnyRunHandle
  ? TRunId
  : TRunId extends AnyTask
  ? string
  : TRunId extends string
  ? TRunId
  : never;

type InferRunId<TRunId> = TRunId extends RunHandle<infer TPayload, infer TOutput>
  ? { output?: TOutput; payload: TPayload }
  : TRunId extends Task<string, infer TTaskPayload, infer TTaskOutput>
  ? {
      output?: TTaskOutput;
      payload: TTaskPayload;
    }
  : { output?: any; payload: any };

function retrieveRun<TRunId extends AnyRunHandle | AnyTask | string>(
  runId: RunId<TRunId>,
  requestOptions?: ApiRequestOptions
): ApiPromise<RetrieveRunResult<InferRunId<TRunId>["payload"], InferRunId<TRunId>["output"]>> {
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
    },
    requestOptions
  );

  const $runId = typeof runId === "string" ? runId : runId.id;

  return apiClient.retrieveRun($runId, $requestOptions).then((retrievedRun) => {
    return resolvePayloadAndOutputUrls(retrievedRun);
  }) as ApiPromise<RetrieveRunResult<TRunId>>;
}

async function resolvePayloadAndOutputUrls(run: RetrieveRunResult<any, any>) {
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

async function subscribeToRun<TRunId extends AnyRunHandle | AnyTask | string>(
  runId: RunId<TRunId>,
  callback?: RunStreamCallback<InferRunId<TRunId>["payload"], InferRunId<TRunId>["output"]>
): Promise<RunSubscription<InferRunId<TRunId>["payload"], InferRunId<TRunId>["output"]>> {
  const $runId = typeof runId === "string" ? runId : runId.id;

  const apiClient = apiClientManager.clientOrThrow();

  return apiClient.subscribeToRunChanges($runId, callback);
}
