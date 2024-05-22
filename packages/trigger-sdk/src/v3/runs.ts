import {
  CanceledRunResponse,
  ReplayRunResponse,
  RetrieveRunResponse,
  apiClientManager,
} from "@trigger.dev/core/v3";
import { apiClientMissingError } from "./shared";

export const runs = {
  replay: replayRun,
  cancel: cancelRun,
  retrieve: retrieveRun,
};

async function retrieveRun(runId: string): Promise<RetrieveRunResponse> {
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  return await apiClient.retrieveRun(runId);
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
