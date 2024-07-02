import type {
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
  apiClientManager,
} from "@trigger.dev/core/v3";
import { Prettify, RunHandle, apiClientMissingError } from "./shared";

export type RetrieveRunResult<TOutput> = Prettify<
  TOutput extends RunHandle<infer THandleOutput>
    ? Omit<RetrieveRunResponse, "output"> & { output?: THandleOutput }
    : Omit<RetrieveRunResponse, "output"> & { output?: TOutput }
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
  params?: ListProjectRunsQueryParams
): CursorPagePromise<typeof ListRunResponseItem>;
function listRuns(params?: ListRunsQueryParams): CursorPagePromise<typeof ListRunResponseItem>;
function listRuns(
  paramsOrProjectRef?: ListRunsQueryParams | string,
  params?: ListRunsQueryParams | ListProjectRunsQueryParams
): CursorPagePromise<typeof ListRunResponseItem> {
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  if (typeof paramsOrProjectRef === "string") {
    return apiClient.listProjectRuns(paramsOrProjectRef, params);
  }

  return apiClient.listRuns(params);
}

function retrieveRun<TRunId extends RunHandle<any> | string>(
  runId: TRunId
): ApiPromise<RetrieveRunResult<TRunId>> {
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  if (typeof runId === "string") {
    return apiClient.retrieveRun(runId) as ApiPromise<RetrieveRunResult<TRunId>>;
  } else {
    return apiClient.retrieveRun(runId.id) as ApiPromise<RetrieveRunResult<TRunId>>;
  }
}

function replayRun(runId: string): ApiPromise<ReplayRunResponse> {
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  return apiClient.replayRun(runId);
}

function cancelRun(runId: string): ApiPromise<CanceledRunResponse> {
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  return apiClient.cancelRun(runId);
}

function rescheduleRun(
  runId: string,
  body: RescheduleRunRequestBody
): ApiPromise<RetrieveRunResponse> {
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  return apiClient.rescheduleRun(runId, body);
}

export type PollOptions = { pollIntervalMs?: number };

async function poll<TRunHandle extends RunHandle<any> | string>(
  handle: TRunHandle,
  options?: { pollIntervalMs?: number }
) {
  while (true) {
    const run = await runs.retrieve(handle);

    if (run.isCompleted) {
      return run;
    }

    await new Promise((resolve) => setTimeout(resolve, options?.pollIntervalMs ?? 1000));
  }
}
