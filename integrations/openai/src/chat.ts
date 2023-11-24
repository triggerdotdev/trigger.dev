import { IntegrationTaskKey, Prettify } from "@trigger.dev/sdk";
import OpenAI from "openai";
import { OpenAIRunTask } from "./index";
import {
  backgroundTaskRetries,
  createBackgroundFetchHeaders,
  createBackgroundFetchUrl,
  createTaskOutputProperties,
  handleOpenAIError,
} from "./taskUtils";
import { OpenAIIntegrationOptions, OpenAIRequestOptions } from "./types";
import { FetchRetryOptions, FetchTimeoutOptions } from "@trigger.dev/integration-kit";

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
          const { data, response } = await client.chat.completions
            .create(params, {
              idempotencyKey: task.idempotencyKey,
              ...options,
            })
            .withResponse();

          task.outputProperties = createTaskOutputProperties(data.usage, response.headers);

          return data;
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
        },
        handleOpenAIError
      );
    },

    backgroundCreate: (
      key: IntegrationTaskKey,
      params: Prettify<OpenAI.Chat.ChatCompletionCreateParamsNonStreaming>,
      options: OpenAIRequestOptions = {},
      fetchOptions: { retries?: FetchRetryOptions; timeout?: FetchTimeoutOptions } = {}
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

          const response = await io.backgroundFetchResponse<OpenAI.Chat.ChatCompletion>(
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
            {
              retry: fetchOptions?.retries ?? backgroundTaskRetries,
              timeout: fetchOptions?.timeout,
            }
          );

          task.outputProperties = createTaskOutputProperties(
            response.data.usage,
            new Headers(response.headers)
          );

          return response.data;
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
          retry: {
            limit: 0,
          },
        }
      );
    },
  };
}
