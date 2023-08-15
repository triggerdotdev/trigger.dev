import AirtableSDK from "airtable";
import type { IntegrationClient, TriggerIntegration } from "@trigger.dev/sdk";
import * as tasks from "./tasks";

export * from "./types";

export type AirtableIntegrationOptions = {
  id: string;
  apiKey?: string;
};

export class Airtable implements TriggerIntegration<IntegrationClient<AirtableSDK, typeof tasks>> {
  client: IntegrationClient<AirtableSDK, typeof tasks>;

  constructor(private options: AirtableIntegrationOptions) {
    if (Object.keys(options).includes("apiKey") && !options.apiKey) {
      throw `Can't create Airtable integration (${options.id}) as apiKey was passed in but undefined`;
    }

    if (options.apiKey) {
      const client = new AirtableSDK({
        apiKey: options.apiKey,
      });

      this.client = {
        usesLocalAuth: true,
        client,
        tasks,
        auth: options.apiKey,
      };

      return;
    }

    this.client = {
      usesLocalAuth: false,
      clientFactory: (auth) => {
        return new AirtableSDK({
          apiKey: auth.accessToken,
        });
      },
      tasks,
    };
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "airtable", name: "Airtable" };
  }
}
