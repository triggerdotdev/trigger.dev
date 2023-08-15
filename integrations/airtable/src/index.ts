
import { Airtable } from "airtable";
import type { IntegrationClient, TriggerIntegration } from "@trigger.dev/sdk";
import { AirtableOptions, AirtableSDK } from "./types";
import * as tasks from "./tasks";

export * from "./types";

type AirtableIntegrationClient = IntegrationClient<AirtableSDK, typeof tasks>;

type AirtableIntegration = TriggerIntegration<AirtableIntegrationClient>;

export class AirtableIntegration
  implements AirtableIntegration
{
  client: AirtableIntegrationClient;

  constructor(private options: AirtableOptions) {
    this.client = {
      tasks,
      usesLocalAuth: false,
      clientFactory: (auth) => {
        return new Airtable({ apiKey: auth.accessToken });
      },
    };
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "airtable", name: "Airtable" };
  }
}
