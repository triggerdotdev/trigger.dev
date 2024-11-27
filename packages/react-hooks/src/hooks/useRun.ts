"use client";

import { AnyTask, RetrieveRunResult } from "@trigger.dev/core/v3";
import { CommonTriggerHookOptions, useSWR } from "../utils/trigger-swr.js";
import { useApiClient } from "./useApiClient.js";

/**
 * Custom hook to retrieve and manage the state of a run by its ID.
 *
 * @template TTask - The type of the task associated with the run.
 * @param {string} runId - The unique identifier of the run to retrieve.
 * @param {CommonTriggerHookOptions} [options] - Optional configuration for the hook's behavior.
 * @returns {Object} An object containing the run data, error, loading state, validation state, and error state.
 * @returns {RetrieveRunResult<TTask> | undefined} run - The retrieved run data.
 * @returns {Error | undefined} error - The error object if an error occurred.
 * @returns {boolean} isLoading - Indicates if the run data is currently being loaded.
 * @returns {boolean} isValidating - Indicates if the run data is currently being validated.
 * @returns {boolean} isError - Indicates if an error occurred during the retrieval of the run data.
 */
export function useRun<TTask extends AnyTask>(
  runId: string,
  options?: CommonTriggerHookOptions
): {
  run: RetrieveRunResult<TTask> | undefined;
  error: Error | undefined;
  isLoading: boolean;
  isValidating: boolean;
  isError: boolean;
} {
  const apiClient = useApiClient(options);
  const {
    data: run,
    error,
    isLoading,
    isValidating,
  } = useSWR<RetrieveRunResult<TTask>>(
    runId,
    () => {
      if (!apiClient) {
        throw new Error("Could not call useRun: Missing access token");
      }

      return apiClient.retrieveRun(runId);
    },
    {
      revalidateOnReconnect: options?.revalidateOnReconnect,
      refreshInterval: (run) => {
        if (!run) return options?.refreshInterval ?? 0;

        if (run.isCompleted) return 0;

        return options?.refreshInterval ?? 0;
      },
      revalidateOnFocus: options?.revalidateOnFocus,
    }
  );

  return { run, error, isLoading, isValidating, isError: !!error };
}
