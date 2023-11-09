import { IntegrationTaskKey, Prettify } from "@trigger.dev/sdk";
import { OpenAIRunTask } from "./index";
import { OpenAIIntegrationOptions, OpenAIRequestOptions } from "./types";
import OpenAI from "openai";
import { createTaskOutputProperties, handleOpenAIError } from "./taskUtils";

export class Assistants {
  constructor(
    private runTask: OpenAIRunTask,
    private options: OpenAIIntegrationOptions
  ) {}

  async create(
    key: IntegrationTaskKey,
    params: Prettify<OpenAI.Beta.AssistantCreateParams>,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Beta.Assistant> {
    return this.runTask(
      key,
      async (client, task) => {
        const { data, response } = await client.beta.assistants
          .create(params, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          })
          .withResponse();

        const outputProperties = createTaskOutputProperties(undefined, response.headers);

        task.outputProperties = [
          ...(outputProperties ?? []),
          {
            label: "assistantId",
            text: data.id,
          },
        ];

        return data;
      },
      {
        name: "Create Assistant",
        params,
        properties: [
          {
            label: "model",
            text: params.model,
          },
          ...(params.name ? [{ label: "name", text: params.name }] : []),
          ...(params.file_ids && params.file_ids.length > 0
            ? [{ label: "files", text: params.file_ids.join(", ") }]
            : []),
        ],
      },
      handleOpenAIError
    );
  }
}
