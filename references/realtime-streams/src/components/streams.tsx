"use client";

import { useRealtimeStream } from "@trigger.dev/react-hooks";
import { Streamdown } from "streamdown";
import { demoStream } from "@/app/streams";

export function Streams({
  accessToken,
  runId,
  isMarkdown,
}: {
  accessToken: string;
  runId: string;
  isMarkdown: boolean;
}) {
  const { parts, error } = useRealtimeStream(demoStream, runId, {
    accessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
    onData: (data) => {
      // console.log(data);
    },
    timeoutInSeconds: 600,
  });

  if (error) return <div className="text-red-600 font-semibold">Error: {error.message}</div>;

  if (!parts) return <div className="text-gray-600">Loading...</div>;

  const stream = parts.join("");

  return (
    <div className="space-y-4">
      <div className="text-sm font-medium text-gray-700">
        <span className="font-semibold">Run:</span> {runId}
      </div>
      <div className="prose prose-sm max-w-none text-gray-900">
        {isMarkdown ? <Streamdown isAnimating={true}>{stream}</Streamdown> : stream}
      </div>
    </div>
  );
}
