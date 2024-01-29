"use client";

import { UseQueryResult, useQuery } from "@tanstack/react-query";
import { GetRun, GetRunOptions, GetRunSchema, urlWithSearchParams } from "@trigger.dev/core";
import { useTriggerProvider } from "./TriggerProvider";
import { zodfetch } from "./fetch";

export const runResolvedStatuses = ["SUCCESS", "FAILURE", "CANCELED", "TIMED_OUT", "ABORTED"];

const defaultRefreshInterval = 1000;

export type RunDetailOptions = GetRunOptions & {
  /** How often you want to refresh, the default is 1000. Min is 500  */
  refreshIntervalMs?: number;
};

export type UseRunDetailsResult = UseQueryResult<GetRun>;

export function useRunDetails(
  runId: string | undefined,
  options?: RunDetailOptions
): UseRunDetailsResult {
  const { apiUrl, publicApiKey, queryClient } = useTriggerProvider();

  const { refreshIntervalMs: refreshInterval, ...otherOptions } = options || {};

  const url = urlWithSearchParams(`${apiUrl}/api/v2/runs/${runId}`, otherOptions);

  return useQuery(
    {
      queryKey: [`triggerdotdev-run-${runId}`],
      queryFn: async () => {
        return await zodfetch(GetRunSchema, url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${publicApiKey}`,
          },
        });
      },
      enabled: !!runId,
      refetchInterval: (data) => {
        if (data?.status && runResolvedStatuses.includes(data.status)) {
          return false;
        }
        if (refreshInterval !== undefined) {
          return Math.max(refreshInterval, 500);
        }

        return defaultRefreshInterval;
      },
    },
    queryClient
  );
}
