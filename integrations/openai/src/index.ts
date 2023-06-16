import { OpenAIApi, Configuration } from "openai";
import type { IntegrationClient, TriggerIntegration } from "@trigger.dev/sdk";
import { createCompletion } from "./tasks";

const tasks = {
  createCompletion,
};

export type OpenAIIntegrationOptions = {
  id: string;
  apiKey: string;
  organization?: string;
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
    };
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "openai", name: "OpenAI" };
  }
}
