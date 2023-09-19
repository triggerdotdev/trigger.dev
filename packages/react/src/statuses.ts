"use client";

import { UseQueryResult, useQuery } from "@tanstack/react-query";
import {
  GetRun,
  GetRunOptions,
  GetRunSchema,
  GetRunStatuses,
  GetRunStatusesSchema,
  urlWithSearchParams,
} from "@trigger.dev/core";
import { useTriggerProvider } from "./TriggerProvider";
import { zodfetch } from "./fetch";
import { useEventDetails } from "./events";

export const runResolvedStatuses = ["SUCCESS", "FAILURE", "CANCELED", "TIMED_OUT", "ABORTED"];

const defaultRefreshInterval = 1000;

export type RunStatusesOptions = {
  /** How often you want to refresh, the default is 1000. Min is 500  */
  refreshIntervalMs?: number;
};

export type UseRunStatusesResult = GetRunStatuses & { isFetching: boolean; error?: Error };

export function useRunStatuses(
  runId: string | undefined,
  options?: RunStatusesOptions
): UseRunStatusesResult {
  const { apiUrl, publicApiKey, queryClient } = useTriggerProvider();

  const queryResult = useQuery(
    {
      queryKey: [`triggerdotdev-run-${runId}`],
      queryFn: async () => {
        return await zodfetch(GetRunStatusesSchema, `${apiUrl}/api/v1/runs/${runId}/statuses`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${publicApiKey}`,
          },
        });
      },
      enabled: !!runId,
      refetchInterval: (data) => {
        if (data?.run.status && runResolvedStatuses.includes(data.run.status)) {
          return false;
        }
        if (options.refreshIntervalMs !== undefined) {
          return Math.max(options.refreshIntervalMs, 500);
        }

        return defaultRefreshInterval;
      },
    },
    queryClient
  );

  return {
    isFetching: queryResult.isLoading,
    error: queryResult.error,
    run: queryResult.data.run,
    statuses: queryResult.data.statuses,
  };
}

export function useEventRunStatuses(
  eventId: string | undefined,
  options?: RunStatusesOptions
): UseRunStatusesResult {
  const event = useEventDetails(eventId);
  return useRunStatuses(event.data?.runs[0]?.id, options);
}
