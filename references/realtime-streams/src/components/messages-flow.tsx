"use client";

import { useState } from "react";
import { useRealtimeRun, useInputStreamSend } from "@trigger.dev/react-hooks";
import type { messagesTask } from "@/trigger/messages";

export function MessagesFlow({
  runId,
  accessToken,
}: {
  runId: string;
  accessToken: string;
}) {
  const [inputText, setInputText] = useState("");
  const { run, error: runError } = useRealtimeRun<typeof messagesTask>(runId, {
    accessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
  });
  const {
    send,
    isLoading: isSending,
    error: sendError,
  } = useInputStreamSend<{ text: string }>("messages", runId, {
    accessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
  });

  const status = run?.metadata?.status as string | undefined;
  const received = (run?.metadata?.received as number) ?? 0;
  const expected = (run?.metadata?.expected as number) ?? 0;
  const isListening = status === "listening";
  const isDone = status === "done";
  const isCompleted = run?.status === "COMPLETED";

  function handleSend() {
    if (!inputText.trim()) return;
    send({ text: inputText.trim() });
    setInputText("");
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <div
          className={`w-3 h-3 rounded-full ${
            isListening
              ? "bg-yellow-400 animate-pulse"
              : isDone
                ? "bg-green-400"
                : "bg-blue-400 animate-pulse"
          }`}
        />
        <span className="text-sm text-gray-600">
          {!run
            ? "Loading..."
            : isListening
              ? `Listening for messages (${received}/${expected})`
              : isDone
                ? `Received all ${received} messages`
                : `Status: ${run?.status ?? "unknown"}`}
        </span>
      </div>

      {isListening && (
        <div className="flex gap-3">
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="Type a message..."
            className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={handleSend}
            disabled={isSending || !inputText.trim()}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors font-medium"
          >
            {isSending ? "Sending..." : "Send"}
          </button>
        </div>
      )}

      {runError && <p className="text-red-500 text-sm">Run error: {runError.message}</p>}
      {sendError && <p className="text-red-500 text-sm">Send error: {sendError.message}</p>}

      {isCompleted && run?.output && (
        <div className="bg-gray-50 p-4 rounded-lg">
          <h3 className="text-sm font-semibold mb-2">Task output:</h3>
          <pre className="text-sm overflow-auto">
            {JSON.stringify(run.output, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
