import { IntegrationTaskKey } from "@trigger.dev/sdk";
import { Model } from "openai/resources";
import { OpenAIRunTask } from "src";

export class Models {
  runTask: OpenAIRunTask;

  constructor(runTask: OpenAIRunTask) {
    this.runTask = runTask;
  }

  retrieve(key: IntegrationTaskKey, params: { model: string }): Promise<Model> {
    return this.runTask(
      key,
      async (client) => {
        return client.models.retrieve(params.model);
      },
      {
        name: "Retrieve model",
        params,
        properties: [
          {
            label: "Model id",
            text: params.model,
          },
        ],
      }
    );
  }

  list(key: IntegrationTaskKey): Promise<Model[]> {
    return this.runTask(key, async (client) => {
      // return new ArrayBuffer(1);
      const result = await client.models.list();
      return result.data;
    });
  }
}
