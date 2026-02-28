"use client";

import useSWRMutation from "swr/mutation";
import { useApiClient, UseApiClientOptions } from "./useApiClient.js";

export interface InputStreamSendInstance<TData> {
  /** Send data to the input stream */
  send: (data: TData) => void;
  /** Whether a send is currently in progress */
  isLoading: boolean;
  /** Any error that occurred during the last send */
  error?: Error;
  /** Whether the hook is ready to send (has runId and access token) */
  isReady: boolean;
}

/**
 * Hook to send data to an input stream on a running task.
 *
 * @template TData - The type of data to send
 * @param streamId - The input stream identifier
 * @param runId - The run to send input stream data to
 * @param options - API client options (e.g. accessToken)
 *
 * @example
 * ```tsx
 * const { send, isLoading } = useInputStreamSend("my-stream", runId, { accessToken });
 * send({ message: "hello" });
 * ```
 */
export function useInputStreamSend<TData>(
  streamId: string,
  runId?: string,
  options?: UseApiClientOptions
): InputStreamSendInstance<TData> {
  const apiClient = useApiClient(options);

  async function sendToStream(key: string, { arg }: { arg: { data: TData } }) {
    if (!apiClient) {
      throw new Error("Could not send to input stream: Missing access token");
    }

    if (!runId) {
      throw new Error("Could not send to input stream: Missing run ID");
    }

    return await apiClient.sendInputStream(runId, streamId, arg.data);
  }

  const mutation = useSWRMutation(runId ? `input-stream:${runId}:${streamId}` : null, sendToStream);

  return {
    send: (data) => {
      mutation.trigger({ data });
    },
    isLoading: mutation.isMutating,
    isReady: !!runId && !!apiClient,
    error: mutation.error,
  };
}
