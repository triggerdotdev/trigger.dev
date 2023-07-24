"use client";

import { useQuery } from "@tanstack/react-query";
import { GetEventSchema } from "@trigger.dev/internal";
import { zodfetch } from "./fetch";
import { useTriggerProvider } from "./TriggerProvider";

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
      refetchInterval: 6000,
    }
  );
}
