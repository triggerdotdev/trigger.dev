import { IntegrationTaskKey, Prettify, redactString } from "@trigger.dev/sdk";
import OpenAI from "openai";
import { OpenAIRunTask } from "./index";
import { createTaskUsageProperties } from "./taskUtils";

export class Chat {
  runTask: OpenAIRunTask;

  constructor(runTask: OpenAIRunTask) {
    this.runTask = runTask;
  }

  completions = {
    create: (
      key: IntegrationTaskKey,
      params: Prettify<OpenAI.Chat.CompletionCreateParamsNonStreaming>
    ): Promise<OpenAI.Chat.ChatCompletion> => {
      return this.runTask(
        key,
        async (client, task) => {
          const response = await client.chat.completions.create(params);
          task.outputProperties = createTaskUsageProperties(response.usage);
          return response;
        },
        {
          name: "Chat Completion",
          params,
          properties: [
            {
              label: "model",
              text: params.model,
            },
          ],
        }
      );
    },

    backgroundCreate: (
      key: IntegrationTaskKey,
      params: Prettify<OpenAI.Chat.CompletionCreateParamsNonStreaming>
    ): Promise<OpenAI.Chat.ChatCompletion> => {
      return this.runTask(
        key,
        async (client, task, io) => {
          const response = await io.backgroundFetch<OpenAI.Chat.ChatCompletion>(
            "background",
            "https://api.openai.com/v1/chat/completions",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: redactString`Bearer ${client.apiKey}`,
                ...(client.organization ? { "OpenAI-Organization": client.organization } : {}),
              },
              body: JSON.stringify(params),
            },
            {
              "500-599": {
                strategy: "backoff",
                limit: 5,
                minTimeoutInMs: 1000,
                maxTimeoutInMs: 30000,
                factor: 1.8,
                randomize: true,
              },
              "429": {
                strategy: "backoff",
                limit: 10,
                minTimeoutInMs: 1000,
                maxTimeoutInMs: 60000,
                factor: 2,
                randomize: true,
              },
            }
          );

          task.outputProperties = createTaskUsageProperties(response.usage);

          return response;
        },
        {
          name: "Background Chat Completion",
          params,
          properties: [
            {
              label: "model",
              text: params.model,
            },
          ],
        }
      );
    },
  };
}
