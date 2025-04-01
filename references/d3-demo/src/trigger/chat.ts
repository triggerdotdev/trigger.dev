import { openai } from "@ai-sdk/openai";
import { CompleteTaskWithOutput, logger, metadata, schemaTask, wait } from "@trigger.dev/sdk/v3";
import { CoreMessage, streamText } from "ai";
import { z } from "zod";

const MAX_STEPS = 10;

export const chatExample = schemaTask({
  id: "chat-example",
  description: "Chat example",
  schema: z.object({
    model: z.string().default("chatgpt-4o-latest"),
    prompt: z.string().default("Hello, how are you?"),
  }),
  run: async ({ model, prompt }) => {
    const aiModel = openai(model);

    let messages: CoreMessage[] = [
      {
        role: "system",
        content:
          "You are a helpful assistant that can answer questions and help with tasks. Please be very concise and to the point.",
      },
      {
        role: "user",
        content: prompt,
      },
    ];

    let step = 0;

    while (step < MAX_STEPS) {
      step++;

      await logger.trace(
        `Step ${step}`,
        async (span) => {
          // This token will expire in 1 day
          const token = await wait.createToken({ timeout: "1d" });

          metadata.set("waitToken", token);
          await metadata.flush();

          const result = streamText({
            model: aiModel,
            messages,
            experimental_telemetry: {
              isEnabled: true,
            },
          });

          logger.info("Received result from streamText");

          const stream = await metadata.stream(`responses.${token.id}`, result.fullStream);

          logger.info("Gathering the text from the stream");

          let assistantResponse = "";

          for await (const chunk of stream) {
            if (chunk.type === "text-delta") {
              assistantResponse += chunk.textDelta;
            }
          }

          logger.info("Assistant response", { assistantResponse });

          messages.push({
            role: "assistant",
            content: assistantResponse,
          });

          // Now wait for the next message
          const nextMessage = await wait.forToken<{ message: string }>(token);

          if (nextMessage.ok) {
            logger.info("Next message", { nextMessage: nextMessage.output.message });

            messages.push({
              role: "user",
              content: nextMessage.output.message,
            });
          } else {
            logger.info("No next message", { nextMessage });

            throw new CompleteTaskWithOutput({ waitpoint: token.id });
          }
        },
        {
          attributes: {
            step,
          },
          icon: "tabler-repeat",
        }
      );
    }
  },
});
