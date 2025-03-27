"use client";

import useSWRMutation from "swr/mutation";
import { useApiClient, UseApiClientOptions } from "./useApiClient.js";

/**
 * Base interface for task trigger instances.
 *
 * @template TOutput - The type of the output
 */
export interface WaitTokenInstance<TOutput> {
  /** Function to complete the waitpoint with an output */
  complete: (output: TOutput) => void;
  /** Whether the waitpoint is currently being completed */
  isLoading: boolean;
  /** Whether the waitpoint has been completed */
  isCompleted: boolean;
  /** Any error that occurred during completion */
  error?: Error;
  /** Whether the waitpoint is ready to be completed */
  isReady: boolean;
}

/**
 * Hook to complete a waitpoint and manage its completion state.
 *
 * @template TOutput - The type of the output
 * @param {string} waitpointId - The identifier of the waitpoint to complete
 * @returns {WaitTokenInstance<TOutput>} An object containing the complete function, loading state, isCompleted, and any errors
 *
 * @example
 * ```ts
 * import type { myTask } from './path/to/task';
 * const { complete, isLoading, isCompleted, error } = useWaitToken('waitpoint-id');
 *
 * // Complete the waitpoint with an output
 * complete({ foo: 'bar' });
 * ```
 */
export function useWaitToken<TOutput>(
  waitpointId?: string,
  options?: UseApiClientOptions
): WaitTokenInstance<TOutput> {
  const apiClient = useApiClient(options);

  async function completeWaitpoint(id: string, { arg: { output } }: { arg: { output: TOutput } }) {
    if (!apiClient) {
      throw new Error("Could not complete waitpoint in useWaitToken: Missing access token");
    }

    if (!waitpointId) {
      throw new Error("Could not complete waitpoint in useWaitToken: Missing waitpoint ID");
    }

    const result = await apiClient.completeWaitpointToken(waitpointId, {
      data: output,
    });

    return result;
  }

  const mutation = useSWRMutation(waitpointId, completeWaitpoint);

  return {
    complete: (output) => {
      // trigger the task with the given payload
      mutation.trigger({ output });
    },
    isLoading: mutation.isMutating,
    isCompleted: !!mutation.data?.success,
    isReady: !!waitpointId,
    error: mutation.error,
  };
}
