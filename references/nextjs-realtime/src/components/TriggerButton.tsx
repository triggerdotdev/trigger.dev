"use client";

import { Button } from "@/components/ui/button";
import { type openaiStreaming } from "@/trigger/ai";
import { TriggerAuthContext, useTaskTrigger } from "@trigger.dev/react-hooks";

function TriggerButton() {
  const { submit, handle, isLoading } = useTaskTrigger<typeof openaiStreaming>("openai-streaming");

  console.log(handle);

  return (
    <Button
      type="submit"
      disabled={isLoading}
      className="p-0 bg-transparent hover:bg-transparent hover:text-gray-200 text-gray-400"
      onClick={() => {
        submit({
          model: "gpt-4o-mini",
          prompt: "What's the weather like in San Francisco today?",
        });
      }}
    >
      {isLoading ? "Triggering..." : "Trigger Task"}
    </Button>
  );
}

export default function TriggerButtonClientWrapper({
  publicAccessToken,
}: {
  publicAccessToken: string;
}) {
  return (
    <TriggerAuthContext.Provider
      value={{ accessToken: publicAccessToken, baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL }}
    >
      <TriggerButton />
    </TriggerAuthContext.Provider>
  );
}
