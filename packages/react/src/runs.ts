"use client";

import { useQuery } from "@tanstack/react-query";
import { GetRunSchema } from "@trigger.dev/internal";
import { zodfetch } from "./fetch";
import { useTriggerProvider } from "./TriggerProvider";

const resolvedStatuses = [
  "SUCCESS",
  "FAILURE",
  "CANCELED",
  "TIMED_OUT",
  "ABORTED",
];
const refreshInterval = 5000;

export function useQueryRun(runId: string) {
  const { apiUrl, publicApiKey } = useTriggerProvider();

  return useQuery(
    [`run-${runId}`],
    async () => {
      return await zodfetch(GetRunSchema, `${apiUrl}/api/v1/runs/${runId}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${publicApiKey}`,
        },
      });
    },
    {
      refetchInterval: (data, query) => {
        if (data?.status && resolvedStatuses.includes(data.status)) {
          return false;
        }
        return refreshInterval;
      },
    }
  );
}
