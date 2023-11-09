import { IntegrationTaskKey } from "@trigger.dev/sdk";
import OpenAI from "openai";
import { OpenAIRunTask } from "./index";
import { createTaskOutputProperties, handleOpenAIError } from "./taskUtils";
import { OpenAIRequestOptions } from "./types";

export class Embeddings {
  runTask: OpenAIRunTask;

  constructor(runTask: OpenAIRunTask) {
    this.runTask = runTask;
  }

  create(
    key: IntegrationTaskKey,
    params: OpenAI.EmbeddingCreateParams,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Embeddings.CreateEmbeddingResponse> {
    return this.runTask(
      key,
      async (client, task) => {
        const { data, response } = await client.embeddings
          .create(params, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          })
          .withResponse();
        task.outputProperties = createTaskOutputProperties(data.usage, response.headers);
        return data;
      },
      {
        name: "Create embedding",
        params,
        properties: [
          {
            label: "Model",
            text: params.model,
          },
        ],
      },
      handleOpenAIError
    );
  }
}
