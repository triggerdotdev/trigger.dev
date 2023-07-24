"use client";

import { useQuery } from "@tanstack/react-query";
import { GetEventSchema } from "@trigger.dev/internal";
import { zodfetch } from "./fetch";
import { useTriggerProvider } from "./TriggerProvider";
import { RunDetailOptions, useRunDetails } from "./runs";

const defaultRefreshInterval = 5000;

export function useEventDetails(eventId: string) {
  const { apiUrl, publicApiKey } = useTriggerProvider();

  return useQuery(
    [`event-${eventId}`],
    async () => {
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
    {
      refetchInterval: defaultRefreshInterval,
    }
  );
}

export function useEventRunDetails(
  eventId: string,
  options?: RunDetailOptions
) {
  const event = useEventDetails(eventId);
  return useRunDetails(event.data?.runs[0]?.id, options);
}
