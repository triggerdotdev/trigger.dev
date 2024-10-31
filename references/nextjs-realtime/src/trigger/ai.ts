import { OpenAI } from "openai";
import { runs, logger, metadata, schemaTask, task, waitUntil } from "@trigger.dev/sdk/v3";
import { z } from "zod";
import { setTimeout } from "node:timers/promises";

const openai = new OpenAI();

export const openaiStreaming = schemaTask({
  id: "openai-streaming",
  schema: z.object({
    model: z.string().default("chatgpt-4o-latest"),
    prompt: z.string().default("Hello, how are you?"),
  }),
  run: async ({ model, prompt }) => {
    logger.info("Running OpenAI model", { model, prompt });

    const result = await openai.chat.completions.create({
      model: model,
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
      stream: true,
    });

    const stream = await metadata.stream("openai", result);

    for await (const chunk of stream) {
    }

    await setTimeout(1000);
  },
});

type STREAMS = { openai: OpenAI.Chat.Completions.ChatCompletionChunk };

export const openaiConsumer = schemaTask({
  id: "openai-consumer",
  schema: z.object({
    model: z.string().default("gpt-3.5-turbo"),
    prompt: z.string().default("Hello, how are you?"),
  }),
  run: async ({ model, prompt }) => {
    const handle = await openaiStreaming.trigger({ model, prompt });

    let openaiCompletion = "";

    for await (const part of runs.subscribeToRun(handle).withStreams<STREAMS>()) {
      switch (part.type) {
        case "run": {
          logger.info("Received run chunk", { run: part.run });
          break;
        }
        case "openai": {
          logger.info("Received OpenAI chunk", { chunk: part.chunk, run: part.run });

          if (part.chunk.choices[0].delta?.content) {
            openaiCompletion += part.chunk.choices[0].delta.content;
          }
        }
      }
    }

    return { openaiCompletion };
  },
});

export const waitUntilExamples = task({
  id: "wait-until-examples",
  run: async () => {
    await setTimeout(30_000);
  },
});
