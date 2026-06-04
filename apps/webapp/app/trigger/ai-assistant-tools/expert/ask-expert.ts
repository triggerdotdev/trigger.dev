import { tool } from "ai";
import { AgentChat } from "@trigger.dev/sdk/chat";
import { askExpert as askExpertSchema } from "~/lib/ai-assistant/tool-schemas";
import type { reasoningAgent } from "../../ai-assistant-reasoning-agent";

export function createAskExpertTool() {
  return tool({
    ...askExpertSchema,
    execute: async function* ({ question }, { abortSignal }) {
      const chat = new AgentChat<typeof reasoningAgent>({
        agent: "reasoning-agent",
      });

      const stream = await chat.sendMessage(question, { abortSignal });
      yield* stream.messages();

      await chat.close();
    },
    toModelOutput: ({ output: message }) => {
      const lastText = message?.parts?.findLast(
        (p: { type: string }) => p.type === "text"
      ) as { text?: string } | undefined;
      return { type: "text", value: lastText?.text ?? "The expert could not answer that." };
    },
  });
}
