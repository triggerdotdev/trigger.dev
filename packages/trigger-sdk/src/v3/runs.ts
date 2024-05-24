import {
  CanceledRunResponse,
  ReplayRunResponse,
  RetrieveRunResponse,
  apiClientManager,
} from "@trigger.dev/core/v3";
import { apiClientMissingError } from "./shared";

export type RetrieveRunResult = RetrieveRunResponse & {
  isQueued: boolean;
  isExecuting: boolean;
  isCompleted: boolean;
  isSuccess: boolean;
  isFailed: boolean;
  isCancelled: boolean;
};

export const runs = {
  replay: replayRun,
  cancel: cancelRun,
  retrieve: retrieveRun,
};

async function retrieveRun(runId: string): Promise<RetrieveRunResult> {
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  const response = await apiClient.retrieveRun(runId);

  const isQueued = response.status === "QUEUED" || response.status === "WAITING_FOR_DEPLOY";
  const isExecuting =
    response.status === "EXECUTING" ||
    response.status === "REATTEMPTING" ||
    response.status === "FROZEN";
  const isCompleted =
    response.status === "COMPLETED" ||
    response.status === "CANCELED" ||
    response.status === "FAILED" ||
    response.status === "CRASHED" ||
    response.status === "INTERRUPTED" ||
    response.status === "SYSTEM_FAILURE";
  const isFailed = isCompleted && response.status !== "COMPLETED";
  const isSuccess = isCompleted && response.status === "COMPLETED";
  const isCancelled = response.status === "CANCELED";

  return {
    ...response,
    isQueued,
    isExecuting,
    isCompleted,
    isSuccess,
    isFailed,
    isCancelled,
  };
}

async function replayRun(runId: string): Promise<ReplayRunResponse> {
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  return await apiClient.replayRun(runId);
}

async function cancelRun(runId: string): Promise<CanceledRunResponse> {
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  return await apiClient.cancelRun(runId);
}
