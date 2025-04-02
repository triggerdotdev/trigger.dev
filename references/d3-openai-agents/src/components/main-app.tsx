"use client";

import type React from "react";

import { useState } from "react";
import { Send } from "lucide-react";
import ChatInterface from "@/components/chat-interface";
import InitialPrompt from "@/components/initial-prompt";
import { useRealtimeTaskTriggerWithStreams, useWaitToken } from "@trigger.dev/react-hooks";
import type { chatExample } from "@/trigger/chat";
import { AgentLoopMetadata } from "@/trigger/schemas";
import type { TextStreamPart } from "ai";

type ChatConversation = Array<{ role: "user" | "assistant"; content: string }>;

type ResponseStreams = {
  [K in `responses.${number | string}`]: TextStreamPart<{}>;
};

export function useChat({ publicAccessToken }: { publicAccessToken: string }) {
  const triggerInstance = useRealtimeTaskTriggerWithStreams<typeof chatExample, ResponseStreams>(
    "chat-example",
    {
      accessToken: publicAccessToken,
      baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
    }
  );
  const [conversation, setConversation] = useState<ChatConversation>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [waitToken, setWaitToken] = useState<AgentLoopMetadata | null>(null);

  const waitTokenInstance = useWaitToken(waitToken?.waitToken.id, {
    enabled: !!waitToken?.waitToken.id,
    accessToken: waitToken?.waitToken.publicAccessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
  });

  const waitTokenStream = waitToken?.waitToken.id
    ? triggerInstance.streams[`responses.${waitToken?.waitToken.id}`]
    : undefined;

  const textStream = waitTokenStream
    ?.map((part) => {
      if (part.type === "text-delta") {
        return part.textDelta;
      }
    })
    .join("");

  console.log("textStream", textStream);

  if (triggerInstance.run) {
    console.log("run", triggerInstance.run);

    const metadata = AgentLoopMetadata.safeParse(triggerInstance.run.metadata);

    if (!metadata.success) {
      console.error("Failed to parse metadata", metadata.error);
    } else {
      console.log("metadata", metadata.data);

      setWaitToken(metadata.data);
    }
  }

  return {
    continueConversation: (prompt: string) => {
      if (waitTokenInstance.isReady) {
        waitTokenInstance.complete({
          message: prompt,
        });
      } else {
        const result = triggerInstance.submit({
          model: "gpt-4o-mini",
          prompt,
        });

        setConversation((prev) => [...prev, { role: "user", content: prompt }]);

        return result;
      }
    },
    conversation,
    isLoading,
  };
}

export default function MainApp({ publicAccessToken }: { publicAccessToken: string }) {
  const { continueConversation, conversation, isLoading } = useChat({ publicAccessToken });
  const [input, setInput] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!input.trim()) return;

    continueConversation(input);
    setInput("");
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-between p-4 md:p-24">
      <div className="w-full max-w-3xl mx-auto h-[80vh] flex flex-col">
        <div className="flex-1 overflow-y-auto mb-4 rounded-lg">
          {conversation.length === 0 ? (
            <InitialPrompt />
          ) : (
            <ChatInterface messages={conversation} />
          )}
        </div>

        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message..."
            className="flex-1 p-3 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="p-3 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <Send size={20} />
          </button>
        </form>
      </div>
    </main>
  );
}
