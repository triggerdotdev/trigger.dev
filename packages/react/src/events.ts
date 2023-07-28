"use client";

import { useQuery } from "@tanstack/react-query";
import { GetEventSchema } from "@trigger.dev/core";
import { useTriggerProvider } from "./TriggerProvider";
import { zodfetch } from "./fetch";
import { RunDetailOptions, runResolvedStatuses, useRunDetails } from "./runs";

const defaultRefreshInterval = 1000;

export function useEventDetails(eventId: string | undefined) {
  const { apiUrl, publicApiKey, queryClient } = useTriggerProvider();

  return useQuery(
    {
      queryKey: [`triggerdotdev-event-${eventId}`],
      queryFn: async () => {
        return await zodfetch(
          GetEventSchema,
          `${apiUrl}/api/v1/events/${eventId}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${publicApiKey}`,
            },
          }
        );
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
  eventId: string,
  options?: RunDetailOptions
) {
  const event = useEventDetails(eventId);
  return useRunDetails(event.data?.runs[0]?.id, options);
}
