"use client";

import { ChatInput } from "./chat-input";
import { ChatMessage } from "./chat-message";
import { ToolCallMessage } from "./tool-call-message";
import { useRealtimeTaskTriggerWithStreams } from "@trigger.dev/react-hooks";
import type { todoChat, STREAMS } from "../trigger/chat";
import { TextStreamPart } from "ai";

type MessageBase = {
  id: string;
  role: "user" | "assistant" | "tool";
};

type UserMessage = MessageBase & {
  role: "user";
  content: string;
};

type AssistantMessage = MessageBase & {
  role: "assistant";
  content: string;
};

type ToolMessage = MessageBase & {
  role: "tool";
  name: string;
  input: any;
  output?: any;
};

type Message = UserMessage | AssistantMessage | ToolMessage;

function getMessagesFromRun(
  run: NonNullable<
    ReturnType<typeof useRealtimeTaskTriggerWithStreams<typeof todoChat, STREAMS>>["run"]
  >,
  fullStream: TextStreamPart<any>[] = []
): Message[] {
  const messages: Message[] = [];

  // Add the user message
  if (run.payload) {
    messages.push({
      id: `user-${run.id}`,
      role: "user",
      content: run.payload.input,
    });
  }

  // Track the current assistant message content
  let currentAssistantContent = "";

  // Keep track of tool calls and their results
  const toolCalls = new Map<string, ToolMessage>();

  // Process the stream
  for (const part of fullStream) {
    if (part.type === "tool-call") {
      const toolMessage: ToolMessage = {
        id: `tool-${part.toolCallId}`,
        role: "tool",
        name: part.toolName,
        input: part.args,
      };
      toolCalls.set(part.toolCallId, toolMessage);
      messages.push(toolMessage);
    } else if (part.type === "tool-result") {
      const toolMessage = toolCalls.get(part.toolCallId);
      if (toolMessage) {
        toolMessage.output = part.result;
      }
    } else if (part.type === "text-delta") {
      currentAssistantContent += part.textDelta;

      // Find or create the assistant message
      const lastMessage = messages[messages.length - 1];
      if (lastMessage?.role === "assistant") {
        messages[messages.length - 1] = {
          ...lastMessage,
          content: currentAssistantContent,
        };
      } else {
        messages.push({
          id: `assistant-${run.id}-${messages.length}`,
          role: "assistant",
          content: currentAssistantContent,
        });
      }
    }
  }

  return messages;
}

export function useTodoChat({ accessToken }: { accessToken: string }) {
  const triggerInstance = useRealtimeTaskTriggerWithStreams<typeof todoChat, STREAMS>("todo-chat", {
    accessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
  });

  const messages = triggerInstance.run
    ? getMessagesFromRun(triggerInstance.run, triggerInstance.streams?.fullStream)
    : [];

  // Consider it submitting if we have a run but no streams yet
  const isSubmitting =
    (triggerInstance.run !== null &&
      !triggerInstance.streams?.fullStream &&
      triggerInstance.handle === null) ||
    triggerInstance.isLoading;

  const dashboardUrl = triggerInstance.run
    ? `${process.env.NEXT_PUBLIC_DASHBOARD_RUNS_URL}/${triggerInstance.run.id}`
    : null;

  return {
    ...triggerInstance,
    messages,
    isSubmitting,
    dashboardUrl,
  };
}

export function ChatContainer({ triggerToken }: { triggerToken: string }) {
  const { messages, submit, isSubmitting, dashboardUrl } = useTodoChat({
    accessToken: triggerToken,
  });

  return (
    <div className="max-w-4xl mx-auto">
      <div className="bg-white border border-gray-200 rounded-lg shadow-sm">
        <div className="border-b border-gray-200 px-4 py-3 flex items-center">
          <h2 className="text-sm font-medium text-gray-700">Chat Session</h2>
          <span className="ml-2 bg-green-100 text-green-800 text-xs px-2 py-0.5 rounded-full">
            Active
          </span>
          {dashboardUrl && (
            <a
              href={dashboardUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-2 text-xs text-blue-500 hover:text-blue-700 flex items-center gap-1"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-3 w-3"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" />
                <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" />
              </svg>
              View Run
            </a>
          )}
          <div className="ml-auto flex space-x-2">
            <button className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 border border-gray-200 rounded">
              Clear
            </button>
            <button className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 border border-gray-200 rounded">
              Export
            </button>
          </div>
        </div>

        <div className="h-[600px] overflow-y-auto p-4 space-y-4">
          {messages.map((message) =>
            message.role === "tool" ? (
              <ToolCallMessage
                key={message.id}
                name={message.name}
                input={message.input}
                output={message.output}
              />
            ) : (
              <ChatMessage key={message.id} role={message.role} content={message.content} />
            )
          )}
        </div>

        <div className="border-t border-gray-200 p-4">
          <ChatInput
            isSubmitting={isSubmitting}
            onSubmit={(input) => {
              submit({
                input,
                userId: "user_1234",
              });
            }}
          />
        </div>
      </div>
    </div>
  );
}
