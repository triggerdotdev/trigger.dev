"use client";

import { useChat } from "@ai-sdk/react";
import { TriggerChatTransport } from "@trigger.dev/sdk/chat";
import { useState } from "react";

export function Chat({ accessToken }: { accessToken: string }) {
  const [input, setInput] = useState("");

  const { messages, sendMessage, status, error } = useChat({
    transport: new TriggerChatTransport({
      task: "ai-chat",
      accessToken,
      baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
    }),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || status === "streaming") return;

    sendMessage({ text: input });
    setInput("");
  }

  return (
    <div className="flex flex-col rounded-xl border border-gray-200 bg-white shadow-sm">
      {/* Messages */}
      <div className="flex-1 space-y-4 overflow-y-auto p-4" style={{ maxHeight: "60vh" }}>
        {messages.length === 0 && (
          <p className="text-center text-sm text-gray-400">Send a message to start chatting.</p>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] rounded-lg px-4 py-2 text-sm ${
                message.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-900"
              }`}
            >
              {message.parts.map((part, i) => {
                if (part.type === "text") {
                  return <span key={i}>{part.text}</span>;
                }
                return null;
              })}
            </div>
          </div>
        ))}

        {status === "streaming" && (
          <div className="flex justify-start">
            <div className="rounded-lg bg-gray-100 px-4 py-2 text-sm text-gray-400">
              Thinking…
            </div>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="border-t border-red-100 bg-red-50 px-4 py-2 text-sm text-red-600">
          {error.message}
        </div>
      )}

      {/* Input */}
      <form onSubmit={handleSubmit} className="flex gap-2 border-t border-gray-200 p-4">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message…"
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
        />
        <button
          type="submit"
          disabled={!input.trim() || status === "streaming"}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  );
}
