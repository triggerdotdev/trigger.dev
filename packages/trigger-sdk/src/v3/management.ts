import { CanceledRunResponse, ReplayRunResponse, apiClientManager } from "@trigger.dev/core/v3";
import { apiClientMissingError } from "./shared";

export async function replayRun(runId: string): Promise<ReplayRunResponse> {
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  const response = await apiClient.replayRun(runId);

  if (!response.ok) {
    throw new Error(response.error);
  }

  return response.data;
}

export async function cancelRun(runId: string): Promise<CanceledRunResponse> {
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  const response = await apiClient.cancelRun(runId);

  if (!response.ok) {
    throw new Error(response.error);
  }

  return response.data;
}
