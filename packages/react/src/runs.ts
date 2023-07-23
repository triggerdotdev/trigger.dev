"use client";

import { useQuery } from "@tanstack/react-query";
import { GetRunSchema } from "@trigger.dev/internal";
import { zodfetch } from "./fetch";
import { useTriggerProvider } from "./TriggerProvider";

export function useQueryRun(runId: string) {
  const { apiUrl, publicApiKey } = useTriggerProvider();

  return useQuery(
    [`run-${runId}`],
    async () => {
      return await zodfetch(
        GetRunSchema,
        `${apiUrl}/api/v1/runs/${runId}/tasks`,
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
