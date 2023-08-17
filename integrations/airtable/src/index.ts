import { Prettify } from "@trigger.dev/integration-kit";
import type { ConnectionAuth, IO, IntegrationTaskKey, TriggerIntegration } from "@trigger.dev/sdk";
import AirtableSDK, { FieldSet } from "airtable";
import { AirtableFieldSet } from "./types";

export * from "./types";

export type AirtableIntegrationOptions = {
  /** An ID for this client  */
  id: string;
  /** Use this if you pass in a [Personal Access Token](https://airtable.com/developers/web/guides/personal-access-tokens). If omitted, it will use OAuth.  */
  token?: string;
};

export class Airtable implements TriggerIntegration {
  _options: AirtableIntegrationOptions;
  _client?: AirtableSDK;
  _io?: IO;

  constructor(private options: Prettify<AirtableIntegrationOptions>) {
    if (Object.keys(options).includes("token") && !options.token) {
      throw `Can't create Airtable integration (${options.id}) as token was passed in but undefined`;
    }

    this._options = options;
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

  get client(): AirtableSDK {
    if (!this._client) throw new Error("No client");
    return this._client;
  }

  get io(): IO {
    if (!this._io) throw new Error("No IO");
    return this._io;
  }

  cloneForRun(io: IO, auth?: ConnectionAuth) {
    const airtable = new Airtable(this._options);
    airtable._io = io;
    if (auth) {
      airtable._client = new AirtableSDK({
        apiKey: auth.accessToken,
      });
    }

    if (this._options.token) {
      airtable._client = new AirtableSDK({
        apiKey: this._options.token,
      });
    }

    return airtable;
  }

  getRecords(key: IntegrationTaskKey, baseId: string, tableName: string) {
    return this.io.runTask(key, { name: "Get record" }, async () => {
      const result = await this.client.base(baseId).table(tableName).select().all();
      const fields = result.map((record) => record.fields);
      return fields as AirtableFieldSet[];
    });
  }
}
