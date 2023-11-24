import { IntegrationTaskKey } from "@trigger.dev/sdk";
import { Model } from "openai/resources";
import { OpenAIRunTask } from "./index";
import OpenAI from "openai";
import { OpenAIRequestOptions } from "./types";
import { handleOpenAIError } from "./taskUtils";

type DeleteFineTunedModelRequest = {
  fineTunedModelId: string;
};
export class Models {
  runTask: OpenAIRunTask;

  constructor(runTask: OpenAIRunTask) {
    this.runTask = runTask;
  }

  retrieve(
    key: IntegrationTaskKey,
    params: { model: string },
    options: OpenAIRequestOptions = {}
  ): Promise<Model> {
    return this.runTask(
      key,
      async (client) => {
        return client.models.retrieve(params.model, options);
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
      },
      handleOpenAIError
    );
  }

  list(key: IntegrationTaskKey, options: OpenAIRequestOptions = {}): Promise<Model[]> {
    return this.runTask(
      key,
      async (client) => {
        const result = await client.models.list(options);
        return result.data;
      },
      {
        name: "List models",
        properties: [],
      },
      handleOpenAIError
    );
  }

  delete(
    key: IntegrationTaskKey,
    params: DeleteFineTunedModelRequest,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Models.ModelDeleted> {
    return this.runTask(
      key,
      async (client) => {
        return client.models.del(params.fineTunedModelId, options);
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
      },
      handleOpenAIError
    );
  }
}
