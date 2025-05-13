import { openai } from "@ai-sdk/openai";
import { logger, metadata, runs, schemaTask, task, toolTask, wait } from "@trigger.dev/sdk/v3";
import { streamText, type TextStreamPart } from "ai";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import OpenAI from "openai";
import { AISDKExporter } from "langsmith/vercel";

const openaiSDK = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export type STREAMS = {
  openai: TextStreamPart<{ getWeather: typeof weatherTask.tool }>;
  openaiText: string;
};

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

          switch (part.chunk.type) {
            case "text-delta": {
              openaiCompletion += part.chunk.textDelta;
              break;
            }
            case "tool-call": {
              switch (part.chunk.toolName) {
                case "getWeather": {
                  console.log("Calling getWeather tool with args", { args: part.chunk.args });
                }
              }
              break;
            }
            case "tool-result": {
              switch (part.chunk.toolName) {
                case "getWeather": {
                  console.log("Received getWeather tool result", { result: part.chunk.result });
                }
              }
              break;
            }
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

export const weatherTask = toolTask({
  id: "weather",
  description: "Get the weather for a location",
  parameters: z.object({
    location: z.string(),
  }),
  run: async ({ location }) => {
    // Simulate a long-running task
    await wait.for({ seconds: 5 });
    // return mock data
    return {
      location,
      temperature: 72 + Math.floor(Math.random() * 21) - 10,
    };
  },
});

export const openaiStreaming = schemaTask({
  id: "openai-streaming",
  description: "Stream data from OpenAI to get the weather",
  schema: z.object({
    model: z.string().default("chatgpt-4o-latest"),
    prompt: z.string().default("Hello, how are you?"),
  }),
  run: async ({ model, prompt }) => {
    logger.info("Running OpenAI model", { model, prompt });

    const telemetrySettings = AISDKExporter.getSettings();

    logger.info("Telemetry settings", { telemetrySettings });

    const result = streamText({
      model: openai(model),
      prompt,
      experimental_telemetry: telemetrySettings,
    });

    const stream = await metadata.stream("openai", result.fullStream);

    for await (const chunk of stream) {
      logger.log("Received chunk", { chunk });
    }
  },
});

export const openaiO1Model = schemaTask({
  id: "openai-o1-model",
  description: "Stream data from OpenAI to get the weather",
  schema: z.object({
    model: z.string().default("o1-preview"),
    prompt: z.string().default("Hello, how are you?"),
  }),
  run: async ({ model, prompt }) => {
    logger.info("Running OpenAI model", { model, prompt });

    const result = await streamText({
      model: openai(model),
      prompt,
      experimental_continueSteps: true,
    });

    const stream = await metadata.stream("openai", result.textStream);

    let text = "";

    for await (const chunk of stream) {
      logger.log("Received chunk", { chunk });

      text += chunk;
    }

    return { text };
  },
});

export const fetchStream = schemaTask({
  id: "fetch-stream",
  description: "Stream data from fetch",
  schema: z.object({
    url: z.string().url(),
  }),
  run: async ({ url }) => {
    logger.info("Streaming response", { url });

    const response = await fetch(url);

    if (!response.body) {
      throw new Error("Response body is not readable");
    }

    const stream = await metadata.stream(
      "fetch",
      response.body.pipeThrough(new TextDecoderStream())
    );

    let text = "";

    for await (const chunk of stream) {
      logger.log("Received chunk", { chunk });

      text += chunk;
    }

    return { text };
  },
});

export const openaiSDKStreaming = schemaTask({
  id: "openai-sdk-streaming",
  description: "Stream data from the OpenAI SDK",
  schema: z.object({
    model: z.string().default("gpt-3.5-turbo"),
    prompt: z.string().default("Hello, how are you?"),
  }),
  run: async ({ model, prompt }) => {
    logger.info("Running OpenAI model", { model, prompt });

    const completion = await openaiSDK.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "gpt-3.5-turbo",
      stream: true,
    });

    const stream = await metadata.stream("openai", completion);

    let text = "";

    for await (const chunk of stream) {
      logger.log("Received chunk", { chunk });

      text += chunk.choices.map((choice) => choice.delta?.content).join("");
    }

    return { text };
  },
});
