"use client";

import { aiStream } from "@/app/streams";
import { useRealtimeStream } from "@trigger.dev/react-hooks";
import type { UIMessage } from "ai";
import { Streamdown } from "streamdown";

export function AIChat({ accessToken, runId }: { accessToken: string; runId: string }) {
  return (
    <div className="space-y-8">
      <AIChatStats accessToken={accessToken} runId={runId} />
      <AIChatFull accessToken={accessToken} runId={runId} />
    </div>
  );
}

function AIChatStats({ accessToken, runId }: { accessToken: string; runId: string }) {
  const { parts, error } = useRealtimeStream(aiStream, runId, {
    accessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
    timeoutInSeconds: 600,
  });

  if (error) return <div className="text-red-600 font-semibold">Error: {error.message}</div>;

  if (!parts || parts.length === 0) {
    return (
      <div className="p-4 rounded-lg bg-blue-50 border-l-4 border-blue-500">
        <div className="text-sm font-semibold text-blue-900 mb-2">📊 Stream Statistics</div>
        <div className="text-xs text-blue-700">Waiting for stream data...</div>
      </div>
    );
  }

  console.log(parts);

  // Calculate statistics
  const stats = {
    totalChunks: parts.length,
    textStartChunks: 0,
    textDeltaChunks: 0,
    textEndChunks: 0,
    errorChunks: 0,
    otherChunks: 0,
    totalCharacters: 0,
    averageChunkSize: 0,
  };

  const chunkTimings: number[] = [];
  let firstChunkTime: number | null = null;
  let lastChunkTime: number | null = null;

  for (const chunk of parts) {
    switch (chunk.type) {
      case "text-start":
        stats.textStartChunks++;
        break;
      case "text-delta":
        stats.textDeltaChunks++;
        stats.totalCharacters += chunk.delta.length;
        break;
      case "text-end":
        stats.textEndChunks++;
        break;
      case "error":
        stats.errorChunks++;
        break;
      default:
        stats.otherChunks++;
    }
  }

  stats.averageChunkSize =
    stats.textDeltaChunks > 0 ? Math.round(stats.totalCharacters / stats.textDeltaChunks) : 0;

  const isStreaming = stats.textEndChunks === 0;

  return (
    <div className="p-4 rounded-lg bg-blue-50 border-l-4 border-blue-500">
      <div className="text-sm font-semibold text-blue-900 mb-3">
        📊 Stream Statistics {isStreaming && <span className="text-blue-600">(live)</span>}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
        <div>
          <div className="text-blue-600 font-semibold">Total Chunks</div>
          <div className="text-blue-900 text-lg font-bold">{stats.totalChunks}</div>
        </div>
        <div>
          <div className="text-blue-600 font-semibold">Text Deltas</div>
          <div className="text-blue-900 text-lg font-bold">{stats.textDeltaChunks}</div>
        </div>
        <div>
          <div className="text-blue-600 font-semibold">Total Characters</div>
          <div className="text-blue-900 text-lg font-bold">{stats.totalCharacters}</div>
        </div>
        <div>
          <div className="text-blue-600 font-semibold">Avg Chunk Size</div>
          <div className="text-blue-900 text-lg font-bold">{stats.averageChunkSize} chars</div>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-blue-200 grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
        <div>
          <span className="text-blue-600">text-start:</span>{" "}
          <span className="text-blue-900 font-semibold">{stats.textStartChunks}</span>
        </div>
        <div>
          <span className="text-blue-600">text-delta:</span>{" "}
          <span className="text-blue-900 font-semibold">{stats.textDeltaChunks}</span>
        </div>
        <div>
          <span className="text-blue-600">text-end:</span>{" "}
          <span className="text-blue-900 font-semibold">{stats.textEndChunks}</span>
        </div>
        <div>
          <span className="text-blue-600">errors:</span>{" "}
          <span className="text-blue-900 font-semibold">{stats.errorChunks}</span>
        </div>
        <div>
          <span className="text-blue-600">other:</span>{" "}
          <span className="text-blue-900 font-semibold">{stats.otherChunks}</span>
        </div>
      </div>
    </div>
  );
}

function AIChatFull({ accessToken, runId }: { accessToken: string; runId: string }) {
  const { parts, error } = useRealtimeStream(aiStream, runId, {
    accessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
    timeoutInSeconds: 600,
  });

  if (error) return <div className="text-red-600 font-semibold">Error: {error.message}</div>;

  if (!parts) return <div className="text-gray-600">Loading...</div>;

  // Compute derived state directly from parts
  let accumulatedText = "";
  let currentId: string | null = null;
  let isComplete = false;

  for (const chunk of parts) {
    switch (chunk.type) {
      case "text-start":
        if (!currentId) {
          currentId = chunk.id;
        }
        break;
      case "text-delta":
        accumulatedText += chunk.delta;
        break;
      case "text-end":
        isComplete = true;
        break;
      case "error":
        console.error("Stream error:", chunk.errorText);
        break;
    }
  }

  // Determine what to render
  const messages: UIMessage[] = [];
  let currentText = "";
  let currentMessageId: string | null = null;
  let currentRole: "assistant" | null = null;

  if (isComplete && currentId && accumulatedText) {
    // Streaming is complete, show as completed message
    messages.push({
      id: currentId,
      role: "assistant",
      parts: [{ type: "text", text: accumulatedText }],
    });
  } else if (currentId) {
    // Still streaming
    currentText = accumulatedText;
    currentMessageId = currentId;
    currentRole = "assistant";
  }

  return (
    <div className="space-y-6">
      <div className="text-sm font-medium text-gray-700 mb-4">
        <span className="font-semibold">Run:</span> {runId}
      </div>

      {/* Render completed messages */}
      {messages.map((message) => (
        <div key={message.id} className="p-4 rounded-lg bg-gray-50 border-l-4 border-purple-500">
          <div className="text-xs font-semibold text-gray-500 uppercase mb-2">{message.role}</div>
          <div className="prose prose-sm max-w-none text-gray-900">
            {message.parts.map((part, idx) =>
              part.type === "text" ? (
                <Streamdown key={idx} isAnimating={false}>
                  {part.text}
                </Streamdown>
              ) : null
            )}
          </div>
        </div>
      ))}

      {/* Render current streaming message */}
      {currentMessageId && currentRole && (
        <div className="p-4 rounded-lg bg-gray-50 border-l-4 border-purple-500">
          <div className="text-xs font-semibold text-gray-500 uppercase mb-2">
            {currentRole} <span className="text-purple-600">(streaming...)</span>
          </div>
          <div className="prose prose-sm max-w-none text-gray-900">
            <Streamdown isAnimating={true}>{currentText}</Streamdown>
          </div>
        </div>
      )}
    </div>
  );
}
