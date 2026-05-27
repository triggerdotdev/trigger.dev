import { chat } from "@trigger.dev/sdk/ai";
import { prompts } from "@trigger.dev/sdk";
import { streamText, createProviderRegistry } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

const registry = createProviderRegistry({ openai });

type RegistryModelId = Parameters<typeof registry.languageModel>[0];

const systemPrompt = prompts.define({
  id: "test-agent-system",
  model: "openai:gpt-4o-mini" satisfies RegistryModelId,
  config: { temperature: 0.7 },
  variables: z.object({ userId: z.string() }),
  content: `You are a helpful AI assistant in the Trigger.dev playground.
The current user is {{userId}}.

## Guidelines
- Be concise and friendly. Prefer short, direct answers.
- Use markdown formatting for code blocks and lists.
- If you don't know something, say so.`,
});

export const testAgent = chat
  .withClientData({
    schema: z.object({
      userId: z.string().optional().default("anonymous"),
      model: z.string().optional().default("openai:gpt-4o-mini"),
    }),
  })
  .onChatStart(async ({ clientData }) => {
    const resolved = await systemPrompt.resolve({
      userId: clientData?.userId ?? "anonymous",
    });
    chat.prompt.set(resolved);
  })
  .agent({
    id: "test-agent",
    run: async ({ messages, clientData, signal }) => {
      // chat.toStreamTextOptions({ registry }) resolves the prompt's model via
      // the registry and injects system prompt + telemetry automatically
      const model = registry.languageModel(clientData?.model ? (clientData.model as RegistryModelId) : "openai:gpt-4o-mini")

      if (!model) {
        throw new Error("Model not found");
      }

      return streamText({
        ...chat.toStreamTextOptions({ registry }),
        model,
        messages,
        abortSignal: signal,
      });
    },
  });
