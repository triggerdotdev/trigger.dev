"use client";

import { triggerAIChatTask } from "@/app/actions";
import { useTransition } from "react";
import type { UIMessage } from "ai";

export function AIChatButton() {
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      // Create a sample conversation to trigger
      const messages: UIMessage[] = [
        {
          id: "1",
          role: "user",
          parts: [
            {
              type: "text",
              text: "Write a detailed explanation of how streaming works in modern web applications, including the benefits and common use cases.",
            },
          ],
        },
      ];

      await triggerAIChatTask(messages);
    });
  }

  return (
    <button
      onClick={handleClick}
      disabled={isPending}
      className="px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
    >
      {isPending ? "Starting AI Chat..." : "🤖 Start AI Chat Stream"}
    </button>
  );
}
