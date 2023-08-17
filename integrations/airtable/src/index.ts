import AirtableSDK from "airtable";
import type { TriggerIntegration } from "@trigger.dev/sdk";
import * as tasks from "./tasks";
import { Prettify } from "@trigger.dev/integration-kit";

export * from "./types";

export type AirtableIntegrationOptions = {
  /** An ID for this client  */
  id: string;
  /** Use this if you pass in a [Personal Access Token](https://airtable.com/developers/web/guides/personal-access-tokens). If omitted, it will use OAuth.  */
  token?: string;
};

export class Airtable implements TriggerIntegration {
  //todo can I have a private property here?
  #options: AirtableIntegrationOptions;

  constructor(private options: Prettify<AirtableIntegrationOptions>) {
    if (Object.keys(options).includes("token") && !options.token) {
      throw `Can't create Airtable integration (${options.id}) as token was passed in but undefined`;
    }

    this.#options = options;
  }

  get authSource() {
    return this.options.token ? ("LOCAL" as const) : ("HOSTED" as const);
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "airtable", name: "Airtable" };
  }

  getClient(): AirtableSDK {
    if (this.#options.token) {
      const client = new AirtableSDK({
        apiKey: this.#options.token,
      });

      return client;
    }

    //todo get the auth details and create the client
    return new AirtableSDK({
      apiKey: auth.accessToken,
    });
  }
}
