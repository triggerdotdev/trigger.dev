"use client";

import { aiStream } from "@/app/streams";
import { TriggerChatTransport } from "@trigger.dev/ai";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import type { TriggerChatRunState } from "@trigger.dev/ai";
import { Streamdown } from "streamdown";
import { useMemo, useState } from "react";

export function AISdkChat({ triggerToken }: { triggerToken: string }) {
  const [input, setInput] = useState("");
  const [lastRunId, setLastRunId] = useState<string | undefined>(undefined);

  const transport = useMemo(function createTransport() {
    return new TriggerChatTransport<UIMessage>({
      task: "ai-chat",
      stream: aiStream,
      accessToken: triggerToken,
      baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
      timeoutInSeconds: 120,
      onTriggeredRun: function onTriggeredRun(state: TriggerChatRunState) {
        setLastRunId(state.runId);
      },
    });
  }, [triggerToken]);

  const chat = useChat({
    transport,
  });

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedInput = input.trim();
    if (!trimmedInput || chat.status === "submitted" || chat.status === "streaming") {
      return;
    }

    chat.sendMessage({
      text: trimmedInput,
    });
    setInput("");
  }

  return (
    <div className="w-full border border-gray-200 rounded-lg p-6 bg-white space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">AI SDK useChat + Trigger.dev task transport</h3>
          <p className="text-sm text-gray-600">
            This chat uses <code>@trigger.dev/ai</code> + Realtime Streams v2
          </p>
        </div>
        <span className="text-xs px-2 py-1 bg-blue-100 text-blue-800 rounded-full">
          {chat.status}
        </span>
      </div>

      {lastRunId ? (
        <div className="text-xs text-gray-500">
          Latest run: <code>{lastRunId}</code>
        </div>
      ) : null}

      <div className="min-h-[220px] max-h-[420px] overflow-y-auto rounded-md border border-gray-100 p-4 space-y-4">
        {chat.messages.length === 0 ? (
          <p className="text-sm text-gray-500">
            Ask anything to start. Messages are streamed through a Trigger.dev task.
          </p>
        ) : (
          chat.messages.map(function renderMessage(message) {
            const messageText = getMessageText(message);

            return (
              <div
                key={message.id}
                className={`rounded-lg p-3 ${
                  message.role === "user"
                    ? "bg-gray-900 text-white ml-10"
                    : "bg-gray-50 text-gray-900 mr-10 border border-gray-200"
                }`}
              >
                <div className="text-[11px] uppercase tracking-wide opacity-70 mb-2">
                  {message.role}
                </div>
                {messageText ? (
                  <div className="prose prose-sm max-w-none">
                    <Streamdown isAnimating={message.role === "assistant"}>
                      {messageText}
                    </Streamdown>
                  </div>
                ) : (
                  <p className="text-sm opacity-70">No text content</p>
                )}
              </div>
            );
          })
        )}
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          value={input}
          onChange={function onChange(event) {
            setInput(event.target.value);
          }}
          placeholder="Ask a question..."
          className="flex-1 px-4 py-2 rounded-md border border-gray-300 text-sm"
        />
        <button
          type="submit"
          disabled={chat.status === "submitted" || chat.status === "streaming"}
          className="px-4 py-2 rounded-md bg-purple-600 text-white text-sm disabled:bg-gray-400"
        >
          Send
        </button>
      </form>
    </div>
  );
}

function getMessageText(message: UIMessage): string {
  let text = "";

  for (const part of message.parts) {
    if (part.type === "text") {
      text += part.text;
      continue;
    }

    if (part.type === "reasoning") {
      text += part.text;
    }
  }

  return text;
}
