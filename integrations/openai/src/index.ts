import type { IntegrationClient, TriggerIntegration } from "@trigger.dev/sdk";
import { Configuration, OpenAIApi } from "openai";
import {
  backgroundCreateChatCompletion,
  backgroundCreateCompletion,
  cancelFineTune,
  createChatCompletion,
  createCompletion,
  createEdit,
  createEmbedding,
  createFile,
  createFineTune,
  createFineTuneFile,
  createImage,
  deleteFineTune,
  listFiles,
  listFineTuneEvents,
  listFineTunes,
  listModels,
  retrieveFineTune,
  retrieveModel,
} from "./tasks";
import { OpenAIIntegrationOptions } from "./types";

const tasks = {
  retrieveModel,
  listModels,
  createCompletion,
  createChatCompletion,
  backgroundCreateCompletion,
  backgroundCreateChatCompletion,
  createEdit,
  createImage,
  createEmbedding,
  createFile,
  listFiles,
  createFineTuneFile,
  createFineTune,
  listFineTunes,
  retrieveFineTune,
  cancelFineTune,
  listFineTuneEvents,
  deleteFineTune,
};

export class OpenAI
  implements TriggerIntegration<IntegrationClient<OpenAIApi, typeof tasks>>
{
  client: IntegrationClient<OpenAIApi, typeof tasks>;

  constructor(private options: OpenAIIntegrationOptions) {
    this.client = {
      tasks,
      usesLocalAuth: true,
      client: new OpenAIApi(
        new Configuration({
          apiKey: options.apiKey,
          organization: options.organization,
        })
      ),
      auth: {
        apiKey: options.apiKey,
        organization: options.organization,
      },
    };
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "openai", name: "OpenAI" };
  }
}
