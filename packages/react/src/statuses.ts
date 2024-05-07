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
import { runResolvedStatuses } from "./runs";

const defaultRefreshInterval = 1000;

export type RunStatusesOptions = {
  /** How often you want to refresh, the default is 1000. Min is 500  */
  refreshIntervalMs?: number;
};

export type UseRunStatusesResult =
  | {
      fetchStatus: "loading";
      error: undefined;
      statuses: undefined;
      run: undefined;
    }
  | {
      fetchStatus: "error";
      error: Error;
      statuses: undefined;
      run: undefined;
    }
  | ({
      fetchStatus: "success";
      error: undefined;
    } & GetRunStatuses);

export function useRunStatuses(
  runId: string | undefined,
  options?: RunStatusesOptions
): UseRunStatusesResult {
  const { apiUrl, publicApiKey, queryClient } = useTriggerProvider();

  const queryResult = useQuery(
    {
      queryKey: [`triggerdotdev-run-statuses-${runId}`],
      queryFn: async () => {
        return await zodfetch(GetRunStatusesSchema, `${apiUrl}/api/v2/runs/${runId}/statuses`, {
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
        if (options?.refreshIntervalMs !== undefined) {
          return Math.max(options.refreshIntervalMs, 500);
        }

        return defaultRefreshInterval;
      },
    },
    queryClient
  );

  switch (queryResult.status) {
    case "pending": {
      return {
        fetchStatus: "loading",
        error: undefined,
        statuses: undefined,
        run: undefined,
      };
    }
    case "error": {
      return {
        fetchStatus: "error",
        error: queryResult.error,
        statuses: undefined,
        run: undefined,
      };
    }
    case "success": {
      return {
        fetchStatus: "success",
        error: undefined,
        run: queryResult.data.run,
        statuses: queryResult.data.statuses,
      };
    }
  }
}

export function useEventRunStatuses(
  eventId: string | undefined,
  options?: RunStatusesOptions
): UseRunStatusesResult {
  const event = useEventDetails(eventId);
  return useRunStatuses(event.data?.runs[0]?.id, options);
}
