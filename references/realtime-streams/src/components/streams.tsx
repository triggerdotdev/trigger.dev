"use client";

import { useRealtimeRunWithStreams } from "@trigger.dev/react-hooks";
import type { STREAMS, streamsTask } from "@/trigger/streams";
import { Streamdown } from "streamdown";

export function Streams({ accessToken, runId }: { accessToken: string; runId: string }) {
  const { run, streams, error } = useRealtimeRunWithStreams<typeof streamsTask, STREAMS>(runId, {
    accessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
  });

  if (error) return <div className="text-red-600 font-semibold">Error: {error.message}</div>;

  if (!run) return <div className="text-gray-600">Loading...</div>;

  const stream = streams.stream?.join("");

  return (
    <div className="space-y-4">
      <div className="text-sm font-medium text-gray-700">
        <span className="font-semibold">Run:</span> {run.id}
        <span className="ml-4 px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs font-semibold">
          {run.status}
        </span>
      </div>
      <div className="prose prose-sm max-w-none text-gray-900">
        <Streamdown isAnimating={true}>{stream}</Streamdown>
      </div>
    </div>
  );
}
