import { IntegrationTaskKey, Prettify, redactString } from "@trigger.dev/sdk";
import OpenAI from "openai";
import { OpenAIRunTask } from "./index";
import { createTaskUsageProperties } from "./taskUtils";

export class Completions {
  runTask: OpenAIRunTask;

  constructor(runTask: OpenAIRunTask) {
    this.runTask = runTask;
  }

  create(
    key: IntegrationTaskKey,
    params: Prettify<OpenAI.CompletionCreateParamsNonStreaming>
  ): Promise<OpenAI.Completion> {
    return this.runTask(
      key,
      async (client, task) => {
        const response = await client.completions.create(params);
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
    params: Prettify<OpenAI.CompletionCreateParamsNonStreaming>
  ): Promise<OpenAI.Completion> {
    return this.runTask(
      key,
      async (client, task, io) => {
        const response = await io.backgroundFetch<OpenAI.Completion>(
          "background",
          "https://api.openai.com/v1/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: redactString`Bearer ${client.apiKey}`,
              ...(client.organization ? { "OpenAI-Organization": client.organization } : {}),
            },
            body: JSON.stringify(params),
          }
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
      }
    );
  }
}
