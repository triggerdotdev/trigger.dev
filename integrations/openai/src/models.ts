import { IntegrationTaskKey } from "@trigger.dev/sdk";
import { Model } from "openai/resources";
import { OpenAIRunTask } from "./index";
import OpenAI from "openai";

type DeleteFineTunedModelRequest = {
  fineTunedModelId: string;
};
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
    return this.runTask(
      key,
      async (client) => {
        const result = await client.models.list();
        return result.data;
      },
      {
        name: "List models",
        properties: [],
      }
    );
  }

  delete(
    key: IntegrationTaskKey,
    params: DeleteFineTunedModelRequest
  ): Promise<OpenAI.Models.ModelDeleted> {
    return this.runTask(
      key,
      async (client) => {
        return client.models.del(params.fineTunedModelId);
      },
      {
        name: "Delete fine tune model",
        params,
        properties: [
          {
            label: "Fine tuned model id",
            text: params.fineTunedModelId,
          },
        ],
      }
    );
  }
}
