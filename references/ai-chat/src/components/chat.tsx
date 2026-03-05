"use client";

import type { UIMessage } from "ai";
import { useChat } from "@ai-sdk/react";
import type { TriggerChatTransport } from "@trigger.dev/sdk/chat";
import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { MODEL_OPTIONS, DEFAULT_MODEL } from "@/lib/models";

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

type ChatProps = {
  chatId: string;
  initialMessages: UIMessage[];
  transport: TriggerChatTransport;
  resume?: boolean;
  onFirstMessage?: (chatId: string, text: string) => void;
  onMessagesChange?: (chatId: string, messages: UIMessage[]) => void;
};

export function Chat({
  chatId,
  initialMessages,
  transport,
  resume: resumeProp,
  onFirstMessage,
  onMessagesChange,
}: ChatProps) {
  const [input, setInput] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const modelByUserMsgId = useRef<Map<string, string>>(new Map());
  const hasCalledFirstMessage = useRef(false);

  const { messages, sendMessage, stop, status, error } = useChat({
    id: chatId,
    messages: initialMessages,
    transport,
    resume: resumeProp,
  });

  // Notify parent of first user message (for chat metadata creation)
  useEffect(() => {
    if (hasCalledFirstMessage.current) return;
    const firstUser = messages.find((m) => m.role === "user");
    if (firstUser) {
      hasCalledFirstMessage.current = true;
      const text = firstUser.parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join(" ");
      onFirstMessage?.(chatId, text);
    }
  }, [messages, chatId, onFirstMessage]);

  // Pending message to send after the current turn completes
  const [pendingMessage, setPendingMessage] = useState<{ text: string; model: string } | null>(null);

  // Handle turn completion: persist messages and auto-send pending message
  const prevStatus = useRef(status);
  useEffect(() => {
    const turnCompleted = prevStatus.current === "streaming" && status === "ready";
    prevStatus.current = status;

    if (!turnCompleted) return;

    // Persist messages when a turn completes — this ensures the final assistant
    // message content is saved (not the empty placeholder from mid-stream).
    if (messages.length > 0) {
      onMessagesChange?.(chatId, messages);
    }

    // Auto-send the pending message
    if (pendingMessage) {
      const { text, model: pendingMsgModel } = pendingMessage;
      setPendingMessage(null);
      pendingModel.current = pendingMsgModel;
      sendMessage({ text }, { metadata: { model: pendingMsgModel } });
    }
  }, [status, messages, chatId, onMessagesChange, sendMessage, pendingMessage]);

  function getModelForAssistantAt(index: number): string | undefined {
    for (let i = index - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        return modelByUserMsgId.current.get(messages[i].id);
      }
    }
    return undefined;
  }

  const originalSendMessage = sendMessage;
  function trackedSendMessage(msg: Parameters<typeof sendMessage>[0], opts?: Parameters<typeof sendMessage>[1]) {
    pendingModel.current = model;
    originalSendMessage(msg, opts);
  }
  const pendingModel = useRef<string>(model);

  const trackedUserIds = useRef<Set<string>>(new Set());
  for (const msg of messages) {
    if (msg.role === "user" && !trackedUserIds.current.has(msg.id)) {
      trackedUserIds.current.add(msg.id);
      modelByUserMsgId.current.set(msg.id, pendingModel.current);
    }
  }

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Messages */}
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="pt-20 text-center text-sm text-gray-400">Send a message to start chatting.</p>
        )}

        {messages.map((message, messageIndex) => (
          <div
            key={message.id}
            className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div className={`max-w-[80%] ${message.role === "user" ? "" : "w-full"}`}>
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

        {pendingMessage && (
          <div className="flex justify-end">
            <div className="max-w-[80%]">
              <div className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white opacity-60">
                {pendingMessage.text}
              </div>
              <div className="mt-1 text-right text-[10px] text-gray-400">
                Queued — will send when current response finishes
              </div>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="shrink-0 border-t border-red-100 bg-red-50 px-4 py-2 text-sm text-red-600">
          {error.message}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim()) return;
          if (status === "streaming") {
            setPendingMessage({ text: input, model });
          } else {
            trackedSendMessage({ text: input }, { metadata: { model } });
          }
          setInput("");
        }}
        className="shrink-0 border-t border-gray-200 bg-white p-4"
      >
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message..."
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
          <button
            type="submit"
            disabled={!input.trim() || !!pendingMessage}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {status === "streaming" ? "Queue" : "Send"}
          </button>
          {status === "streaming" && (
            <button
              type="button"
              onClick={stop}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
            >
              Stop
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
