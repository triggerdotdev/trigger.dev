"use client";

import { useRealtimeStream } from "@trigger.dev/react-hooks";
import type { UIMessage, UIMessageChunk } from "ai";
import { Streamdown } from "streamdown";

export function AIChat({ accessToken, runId }: { accessToken: string; runId: string }) {
  const { parts, error } = useRealtimeStream<UIMessageChunk>(runId, "chat", {
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
