"use client";

import { Card, CardContent, CardFooter } from "@/components/ui/card";
import type { openaiStreaming, STREAMS } from "@/trigger/ai";
import { useRealtimeRunWithStreams } from "@trigger.dev/react-hooks";

function AiRunDetailsWrapper({ runId, accessToken }: { runId: string; accessToken: string }) {
  const { run, streams, error } = useRealtimeRunWithStreams<typeof openaiStreaming, STREAMS>(
    runId,
    {
      accessToken,
      baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
    }
  );

  if (error) {
    return (
      <div className="w-full min-h-screen bg-gray-900 p-4">
        <Card className="w-full bg-gray-800 shadow-md">
          <CardContent className="pt-6">
            <p className="text-red-600">Error: {error.message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="w-full min-h-screen bg-gray-900 py-4 px-6 grid place-items-center">
        <Card className="w-fit bg-gray-800 border border-gray-700 shadow-md">
          <CardContent className="pt-6">
            <p className="text-gray-200">Loading run details…</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const toolCall = streams.openai?.find(
    (stream) => stream.type === "tool-call" && stream.toolName === "getWeather"
  );
  const toolResult = streams.openai?.find((stream) => stream.type === "tool-result");
  const textDeltas = streams.openai?.filter((stream) => stream.type === "text-delta");

  const text = textDeltas?.map((delta) => delta.textDelta).join("");
  const weatherLocation = toolCall ? toolCall.args.location : undefined;
  const weather = toolResult ? toolResult.result.temperature : undefined;

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-100 p-4">
      <Card className="w-full max-w-3xl">
        <CardContent className="p-6">
          <div className="h-[calc(100vh-12rem)] overflow-y-auto">
            {weather ? (
              <p className="text-lg leading-relaxed">{text || "Preparing weather report..."}</p>
            ) : (
              <p className="text-lg">Fetching weather data...</p>
            )}
          </div>
        </CardContent>
        {weather && (
          <CardFooter className="bg-muted p-4">
            <p className="text-sm">
              <span className="font-semibold">Tool Call:</span> The current temperature in{" "}
              {weatherLocation} is {weather}.
            </p>
          </CardFooter>
        )}
      </Card>
    </div>
  );
}

export default function ClientAiDetails({
  runId,
  publicAccessToken,
}: {
  runId: string;
  publicAccessToken: string;
}) {
  return <AiRunDetailsWrapper runId={runId} accessToken={publicAccessToken} />;
}
