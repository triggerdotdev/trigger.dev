import { IntegrationTaskKey, Prettify } from "@trigger.dev/sdk";
import OpenAI from "openai";
import { OpenAIRunTask } from "./index";
import {
  backgroundTaskRetries,
  createBackgroundFetchHeaders,
  createBackgroundFetchUrl,
  createTaskUsageProperties,
} from "./taskUtils";
import { OpenAIIntegrationOptions, OpenAIRequestOptions } from "./types";

export class Chat {
  constructor(
    private runTask: OpenAIRunTask,
    private options: OpenAIIntegrationOptions
  ) {}

  completions = {
    create: (
      key: IntegrationTaskKey,
      params: Prettify<OpenAI.Chat.ChatCompletionCreateParamsNonStreaming>,
      options: OpenAIRequestOptions = {}
    ): Promise<OpenAI.Chat.ChatCompletion> => {
      return this.runTask(
        key,
        async (client, task) => {
          const response = await client.chat.completions.create(params, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          });
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
      params: Prettify<OpenAI.Chat.ChatCompletionCreateParamsNonStreaming>,
      options: OpenAIRequestOptions = {}
    ): Promise<OpenAI.Chat.ChatCompletion> => {
      return this.runTask(
        key,
        async (client, task, io) => {
          const url = createBackgroundFetchUrl(
            client,
            "/chat/completions",
            this.options.defaultQuery,
            options
          );

          const response = await io.backgroundFetch<OpenAI.Chat.ChatCompletion>(
            "background",
            url,
            {
              method: options.method ?? "POST",
              headers: createBackgroundFetchHeaders(
                client,
                task.idempotencyKey,
                this.options.defaultHeaders,
                options
              ),
              body: JSON.stringify(params),
            },
            backgroundTaskRetries
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
