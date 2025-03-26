"use client";

import type React from "react";

import { useState } from "react";
import { Send } from "lucide-react";
import ChatInterface from "@/components/chat-interface";
import InitialPrompt from "@/components/initial-prompt";
import { useRealtimeTaskTriggerWithStreams } from "@trigger.dev/react-hooks";
import type { agentLoopExample } from "@/trigger/agent";

type ChatConversation = Array<{ role: "user" | "assistant"; content: string }>;

export function useAgentLoop({ publicAccessToken }: { publicAccessToken: string }) {
  const triggerInstance = useRealtimeTaskTriggerWithStreams<typeof agentLoopExample>(
    "agent-loop-example",
    {
      accessToken: publicAccessToken,
      baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
    }
  );
  const [conversation, setConversation] = useState<ChatConversation>([]);
  const [isLoading, setIsLoading] = useState(false);

  if (triggerInstance.run) {
    console.log("run", triggerInstance.run);
  }

  return {
    continueConversation: (prompt: string) => {
      const result = triggerInstance.submit({
        model: "gpt-4o-mini",
        prompt,
      });

      setConversation((prev) => [...prev, { role: "user", content: prompt }]);

      return result;
    },
    conversation,
    isLoading,
  };
}

export default function MainApp({ publicAccessToken }: { publicAccessToken: string }) {
  const { continueConversation, conversation, isLoading } = useAgentLoop({ publicAccessToken });
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
