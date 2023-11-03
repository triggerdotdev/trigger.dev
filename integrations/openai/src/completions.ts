import { IntegrationTaskKey, Prettify, redactString } from "@trigger.dev/sdk";
import OpenAI from "openai";
import { OpenAIRunTask } from "./index";
import {
  backgroundTaskRetries,
  createBackgroundFetchHeaders,
  createBackgroundFetchUrl,
  createTaskUsageProperties,
} from "./taskUtils";
import { OpenAIIntegrationOptions, OpenAIRequestOptions } from "./types";
import { FetchRetryOptions, FetchTimeoutOptions } from "@trigger.dev/integration-kit";

export class Completions {
  constructor(
    private runTask: OpenAIRunTask,
    private options: OpenAIIntegrationOptions
  ) {}

  create(
    key: IntegrationTaskKey,
    params: Prettify<OpenAI.CompletionCreateParamsNonStreaming>,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Completion> {
    return this.runTask(
      key,
      async (client, task) => {
        const response = await client.completions.create(params, {
          idempotencyKey: task.idempotencyKey,
          ...options,
        });
        task.outputProperties = createTaskUsageProperties(response.usage);
        return response;
      },
      {
        name: "Completion",
        params,
        properties: [
          {
            label: "model",
            text: params.model,
          },
        ],
      }
    );
  }

  backgroundCreate(
    key: IntegrationTaskKey,
    params: Prettify<OpenAI.CompletionCreateParamsNonStreaming>,
    options: OpenAIRequestOptions = {},
    fetchOptions: { retries?: FetchRetryOptions; timeout?: FetchTimeoutOptions } = {}
  ): Promise<OpenAI.Completion> {
    return this.runTask(
      key,
      async (client, task, io) => {
        const url = createBackgroundFetchUrl(
          client,
          "/completions",
          this.options.defaultQuery,
          options
        );

        const response = await io.backgroundFetch<OpenAI.Completion>(
          "background",
          url,
          {
            method: "POST",
            headers: createBackgroundFetchHeaders(
              client,
              task.idempotencyKey,
              this.options.defaultHeaders,
              options
            ),
            body: JSON.stringify(params),
          },
          fetchOptions.retries ?? backgroundTaskRetries,
          fetchOptions.timeout
        );

        task.outputProperties = createTaskUsageProperties(response.usage);

        return response;
      },
      {
        name: "Background Completion",
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
  }
}
