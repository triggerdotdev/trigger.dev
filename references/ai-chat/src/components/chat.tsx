"use client";

import { useChat } from "@ai-sdk/react";
import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
import { useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { getChatToken } from "@/app/actions";
import { MODEL_OPTIONS, DEFAULT_MODEL } from "@/trigger/chat";
import type { aiChat } from "@/trigger/chat";

function ToolInvocation({ part }: { part: any }) {
  const [expanded, setExpanded] = useState(false);
  const toolName =
    part.type === "dynamic-tool"
      ? (part.toolName ?? "tool")
      : part.type.startsWith("tool-")
        ? part.type.slice(5)
        : "tool";
  const state = part.state ?? "input-available";
  const args = part.input;
  const result = part.output;

  const isLoading = state === "input-streaming" || state === "input-available";
  const isError = state === "output-error";

  return (
    <div className="my-1 rounded border border-gray-200 bg-gray-50 text-xs">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-medium text-gray-700 hover:bg-gray-100"
      >
        {isLoading && (
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
        )}
        {!isLoading && !isError && <span className="text-green-600">&#10003;</span>}
        {isError && <span className="text-red-600">&#10007;</span>}
        <span>{toolName}</span>
        <span className="ml-auto text-gray-400">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="border-t border-gray-200 px-3 py-2 space-y-2">
          {args && Object.keys(args).length > 0 && (
            <div>
              <div className="mb-1 font-medium text-gray-500">Input</div>
              <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-white p-2 text-gray-800">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          {state === "output-available" && result !== undefined && (
            <div>
              <div className="mb-1 font-medium text-gray-500">Output</div>
              <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-white p-2 text-gray-800">
                {JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
          {isError && result !== undefined && (
            <div>
              <div className="mb-1 font-medium text-red-500">Error</div>
              <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-red-50 p-2 text-red-700">
                {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function Chat() {
  const [input, setInput] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  // Track which model was used for each assistant message (keyed by the preceding user message ID)
  const modelByUserMsgId = useRef<Map<string, string>>(new Map());

  const transport = useTriggerChatTransport<typeof aiChat>({
    task: "ai-chat",
    accessToken: getChatToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
  });

  const { messages, sendMessage, stop, status, error } = useChat({
    transport,
  });

  // Build a map of assistant message index -> model used
  // Each assistant message follows a user message, so we track by position
  function getModelForAssistantAt(index: number): string | undefined {
    // Walk backwards to find the preceding user message
    for (let i = index - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        return modelByUserMsgId.current.get(messages[i].id);
      }
    }
    return undefined;
  }

  // When sending, record which model is selected for this user message
  const originalSendMessage = sendMessage;
  function trackedSendMessage(msg: Parameters<typeof sendMessage>[0], opts?: Parameters<typeof sendMessage>[1]) {
    // We'll track it after the message appears — use a ref to store the pending model
    pendingModel.current = model;
    originalSendMessage(msg, opts);
  }
  const pendingModel = useRef<string>(model);

  // Track model for new user messages as they appear
  const trackedUserIds = useRef<Set<string>>(new Set());
  for (const msg of messages) {
    if (msg.role === "user" && !trackedUserIds.current.has(msg.id)) {
      trackedUserIds.current.add(msg.id);
      modelByUserMsgId.current.set(msg.id, pendingModel.current);
    }
  }

  return (
    <div className="flex flex-col rounded-xl border border-gray-200 bg-white shadow-sm">
      {/* Messages */}
      <div className="flex-1 space-y-4 overflow-y-auto p-4" style={{ maxHeight: "60vh" }}>
        {messages.length === 0 && (
          <p className="text-center text-sm text-gray-400">Send a message to start chatting.</p>
        )}

        {messages.map((message, messageIndex) => (
          <div
            key={message.id}
            className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div className={`max-w-[80%] ${message.role === "user" ? "" : "w-full"}`}>
              {/* Model badge for assistant messages */}
              {message.role === "assistant" && (
                <div className="mb-1 flex items-center gap-2 text-[10px] text-gray-400">
                  <span className="rounded bg-gray-200 px-1.5 py-0.5 font-medium text-gray-500">
                    {getModelForAssistantAt(messageIndex) ?? DEFAULT_MODEL}
                  </span>
                </div>
              )}
              <div
                className={`rounded-lg px-4 py-2 text-sm ${
                  message.role === "user"
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 text-gray-900"
                }`}
              >
                {message.parts.map((part, i) => {
                  if (part.type === "text") {
                    if (message.role === "assistant") {
                      return (
                        <Streamdown
                          key={i}
                          animated
                          isAnimating={
                            status === "streaming" &&
                            messageIndex === messages.length - 1
                          }
                        >
                          {part.text}
                        </Streamdown>
                      );
                    }
                    return <span key={i}>{part.text}</span>;
                  }

                  if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
                    return <ToolInvocation key={i} part={part} />;
                  }

                  return null;
                })}
              </div>
            </div>
          </div>
        ))}

        {status === "streaming" && messages[messages.length - 1]?.role !== "assistant" && (
          <div className="flex justify-start">
            <div className="rounded-lg bg-gray-100 px-4 py-2 text-sm text-gray-400">
              Thinking...
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
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim() || status === "streaming") return;
          trackedSendMessage({ text: input }, { metadata: { model } });
          setInput("");
        }}
        className="border-t border-gray-200 p-4"
      >
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message..."
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
          {status === "streaming" ? (
            <button
              type="button"
              onClick={stop}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Send
            </button>
          )}
        </div>
        <div className="mt-2">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-600 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      </form>
    </div>
  );
}
