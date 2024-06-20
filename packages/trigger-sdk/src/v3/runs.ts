import {
  ApiPromise,
  CanceledRunResponse,
  ListRunResponseItem,
  ReplayRunResponse,
  RetrieveRunResponse,
  apiClientManager,
  CursorPagePromise,
} from "@trigger.dev/core/v3";
import type { ListProjectRunsQueryParams, ListRunsQueryParams } from "@trigger.dev/core/v3";
import { apiClientMissingError } from "./shared";

export type RetrieveRunResult = RetrieveRunResponse;

export const runs = {
  replay: replayRun,
  cancel: cancelRun,
  retrieve: retrieveRun,
  list: listRuns,
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

function retrieveRun(runId: string): ApiPromise<RetrieveRunResult> {
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  return apiClient.retrieveRun(runId);
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
