import { IntegrationTaskKey } from "@trigger.dev/sdk";
import OpenAI from "openai";
import { OpenAIRunTask } from "./index";
import { createTaskUsageProperties } from "./taskUtils";

export class Embeddings {
  runTask: OpenAIRunTask;

  constructor(runTask: OpenAIRunTask) {
    this.runTask = runTask;
  }

  create(
    key: IntegrationTaskKey,
    params: OpenAI.EmbeddingCreateParams
  ): Promise<OpenAI.Embeddings.CreateEmbeddingResponse> {
    return this.runTask(
      key,
      async (client, task) => {
        const response = await client.embeddings.create(params);
        task.outputProperties = createTaskUsageProperties(response.usage);
        return response;
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
      }
    );
  }
}
