"use client";

import { UseQueryResult, useQuery } from "@tanstack/react-query";
import { GetEvent, GetEventSchema } from "@trigger.dev/core";
import { useTriggerProvider } from "./TriggerProvider";
import { zodfetch } from "./fetch";
import { RunDetailOptions, UseRunDetailsResult, runResolvedStatuses, useRunDetails } from "./runs";

const defaultRefreshInterval = 1000;

export type UseEventDetailsResult = UseQueryResult<GetEvent>;

export function useEventDetails(eventId: string | undefined): UseEventDetailsResult {
  const { apiUrl, publicApiKey, queryClient } = useTriggerProvider();

  return useQuery(
    {
      queryKey: [`triggerdotdev-event-${eventId}`],
      queryFn: async () => {
        return await zodfetch(GetEventSchema, `${apiUrl}/api/v2/events/${eventId}`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${publicApiKey}`,
          },
        });
      },
      refetchInterval: (data) => {
        if (
          data &&
          data.runs.length > 0 &&
          data.runs.every((r) => runResolvedStatuses.includes(r.status))
        ) {
          return false;
        }

        return defaultRefreshInterval;
      },
      enabled: !!eventId,
    },
    queryClient
  );
}

export function useEventRunDetails(
  eventId: string | undefined,
  options?: RunDetailOptions
): UseRunDetailsResult {
  const event = useEventDetails(eventId);
  return useRunDetails(event.data?.runs[0]?.id, options);
}
