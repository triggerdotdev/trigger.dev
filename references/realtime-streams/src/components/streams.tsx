"use client";

import { useRealtimeRunWithStreams } from "@trigger.dev/react-hooks";
import type { STREAMS, streamsTask } from "@/trigger/streams";

export function Streams({ accessToken, runId }: { accessToken: string; runId: string }) {
  const { run, streams, error } = useRealtimeRunWithStreams<typeof streamsTask, STREAMS>(runId, {
    accessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
  });

  if (error) return <div>Error: {error.message}</div>;

  if (!run) return <div>Loading...</div>;

  const stream = streams.stream?.join("");

  return (
    <div>
      <div>
        Run: {run.id} = {run.status}
      </div>
      <div>{stream}</div>
    </div>
  );
}
