"use client";

import { Button } from "@/components/ui/button";
import type { STREAMS, openaiStreaming } from "@/trigger/ai";
import { useRealtimeRunWithStreams } from "@trigger.dev/react-hooks";

export default function RealtimeComparison({
  accessToken,
  runId,
}: {
  accessToken: string;
  runId: string;
}) {
  const { streams, stop, run } = useRealtimeRunWithStreams<typeof openaiStreaming, STREAMS>(runId, {
    accessToken: accessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
    onComplete: (...args) => {
      console.log("Run completed!", args);
    },
  });

  console.log("run", run);

  return (
    <div className="flex flex-col h-screen bg-gray-900 text-gray-200 text-xs">
      <div className="p-4">
        <Button
          className="bg-gray-100 text-gray-900 hover:bg-gray-200 font-semibold text-xs"
          disabled={true}
        >
          Debug LLM Streaming
        </Button>

        {run && (
          <Button
            className="bg-gray-100 text-gray-900 hover:bg-gray-200 font-semibold text-xs ml-8"
            onClick={() => {
              stop();
            }}
          >
            Stop Streaming
          </Button>
        )}
      </div>
      <div className="flex-grow flex overflow-hidden">
        <div className="w-1/2 border-r border-gray-700 overflow-auto">
          <table className="w-full table-fixed">
            <thead>
              <tr className="bg-gray-800">
                <th className="w-16 p-2 text-left">ID</th>
                <th className="p-2 text-left">Data</th>
              </tr>
            </thead>
            <tbody>
              {(streams.openai ?? []).map((part, i) => (
                <tr key={i} className="border-b border-gray-700">
                  <td className="w-16 p-2 truncate">{i + 1}</td>
                  <td className="p-2">
                    <div className="font-mono whitespace-nowrap overflow-x-auto">
                      {JSON.stringify(part)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="w-1/2 overflow-auto">
          <table className="w-full table-fixed">
            <thead>
              <tr className="bg-gray-800">
                <th className="w-16 p-2 text-left">ID</th>
                <th className="p-2 text-left">Data</th>
              </tr>
            </thead>
            <tbody>
              {(streams.openaiText ?? []).map((text, i) => (
                <tr key={i} className="border-b border-gray-700">
                  <td className="w-16 p-2 truncate">{i + 1}</td>
                  <td className="p-2">
                    <div className="font-mono whitespace-nowrap overflow-x-auto">{text}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
