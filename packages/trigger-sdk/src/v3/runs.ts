import type {
  ApiRequestOptions,
  ListProjectRunsQueryParams,
  ListRunsQueryParams,
  RescheduleRunRequestBody,
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
import { AnyTask, Prettify, RunHandle, Task, apiClientMissingError } from "./shared";
import { tracer } from "./tracer";

export type RetrieveRunResult<TRunId> = Prettify<
  TRunId extends RunHandle<infer TOutput>
    ? Omit<RetrieveRunResponse, "output"> & { output?: TOutput }
    : TRunId extends Task<string, any, infer TTaskOutput>
    ? Omit<RetrieveRunResponse, "output"> & { output?: TTaskOutput }
    : TRunId extends string
    ? RetrieveRunResponse
    : never
>;

export const runs = {
  replay: replayRun,
  cancel: cancelRun,
  retrieve: retrieveRun,
  list: listRuns,
  reschedule: rescheduleRun,
  poll,
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
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

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
type RunId<TRunId> = TRunId extends RunHandle<any>
  ? TRunId
  : TRunId extends AnyTask
  ? string
  : TRunId extends string
  ? TRunId
  : never;

function retrieveRun<TRunId extends RunHandle<any> | AnyTask | string>(
  runId: RunId<TRunId>,
  requestOptions?: ApiRequestOptions
): ApiPromise<RetrieveRunResult<TRunId>> {
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

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

  if (typeof runId === "string") {
    return apiClient.retrieveRun(runId, $requestOptions) as ApiPromise<RetrieveRunResult<TRunId>>;
  } else {
    return apiClient.retrieveRun(runId.id, $requestOptions) as ApiPromise<
      RetrieveRunResult<TRunId>
    >;
  }
}

function replayRun(
  runId: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<ReplayRunResponse> {
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

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
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

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
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

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

async function poll<TRunId extends RunHandle<any> | AnyTask | string>(
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
