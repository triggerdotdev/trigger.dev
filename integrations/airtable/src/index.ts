import AirtableSDK from "airtable";
import type { IntegrationClient, TriggerIntegration } from "@trigger.dev/sdk";
import { Tasks } from "./tasks";
import { Prettify } from "@trigger.dev/integration-kit";

export * from "./types";

export type AirtableIntegrationOptions = {
  /** An ID for this client  */
  id: string;
  /** Use this if you pass in a [Personal Access Token](https://airtable.com/developers/web/guides/personal-access-tokens). If omitted, it will use OAuth.  */
  token?: string;
};

export class Airtable implements TriggerIntegration<IntegrationClient<AirtableSDK, Tasks>> {
  client: IntegrationClient<AirtableSDK, Tasks>;

  constructor(private options: Prettify<AirtableIntegrationOptions>) {
    if (Object.keys(options).includes("token") && !options.token) {
      throw `Can't create Airtable integration (${options.id}) as token was passed in but undefined`;
    }

    if (options.token) {
      const client = new AirtableSDK({
        apiKey: options.token,
      });

      this.client = {
        usesLocalAuth: true,
        client,
        tasks: Tasks,
        auth: options.token,
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
