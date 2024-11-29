"use client";

import { Button } from "@/components/ui/button";
import { type openaiStreaming } from "@/trigger/ai";
import { useTaskTrigger } from "@trigger.dev/react-hooks";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function TriggerButton({ accessToken }: { accessToken: string }) {
  const { submit, handle, isLoading } = useTaskTrigger<typeof openaiStreaming>("openai-streaming", {
    accessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
  });
  const router = useRouter();

  useEffect(() => {
    if (handle) {
      router.push(`/ai/${handle.id}?publicAccessToken=${handle.publicAccessToken}`);
    }
  }, [handle]);

  return (
    <Button
      type="submit"
      disabled={isLoading}
      className="p-0 bg-transparent hover:bg-transparent hover:text-gray-200 text-gray-400"
      onClick={() => {
        submit(
          {
            model: "gpt-4o-mini",
            prompt:
              "Based on the temperature, will I need to wear extra clothes today in San Fransico? Please be detailed.",
          },
          {
            tags: ["user:1234"],
          }
        );
      }}
    >
      {isLoading ? "Triggering..." : "Trigger Task"}
    </Button>
  );
}
