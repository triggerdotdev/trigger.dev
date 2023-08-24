import { Prettify } from "@trigger.dev/integration-kit";
import {
  type ConnectionAuth,
  type IO,
  type IOTask,
  type IntegrationTaskKey,
  type RunTaskErrorCallback,
  type RunTaskOptions,
  type RunTaskResult,
  type TriggerIntegration,
} from "@trigger.dev/sdk";
import AirtableSDK from "airtable";
import { Base } from "./base";
import * as events from "./events";
import {
  WebhookChangeType,
  WebhookDataType,
  Webhooks,
  createTrigger,
  createWebhookEventSource,
} from "./webhooks";

export * from "./types";

export type AirtableIntegrationOptions = {
  /** An ID for this client  */
  id: string;
  /** Use this if you pass in a [Personal Access Token](https://airtable.com/developers/web/guides/personal-access-tokens). If omitted, it will use OAuth.  */
  token?: string;
};

export type AirtableRunTask = InstanceType<typeof Airtable>["runTask"];

export class Airtable implements TriggerIntegration {
  private _options: AirtableIntegrationOptions;
  private _client?: AirtableSDK;
  private _io?: IO;
  private _connectionKey?: string;

  constructor(options: Prettify<AirtableIntegrationOptions>) {
    if (Object.keys(options).includes("token") && !options.token) {
      throw `Can't create Airtable integration (${options.id}) as token was passed in but undefined`;
    }

    this._options = options;
  }

  get authSource() {
    return this._options.token ? ("LOCAL" as const) : ("HOSTED" as const);
  }

  get id() {
    return this._options.id;
  }

  get metadata() {
    return { id: "airtable", name: "Airtable" };
  }

  get source() {
    return createWebhookEventSource(this);
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const airtable = new Airtable(this._options);
    airtable._io = io;
    airtable._connectionKey = connectionKey;
    if (auth) {
      airtable._client = new AirtableSDK({
        apiKey: auth.accessToken,
      });
      return airtable;
    }

    if (this._options.token) {
      airtable._client = new AirtableSDK({
        apiKey: this._options.token,
      });
      return airtable;
    }

    throw new Error("No auth");
  }

  runTask<TResult extends RunTaskResult = void>(
    key: IntegrationTaskKey,
    callback: (client: AirtableSDK, task: IOTask, io: IO) => Promise<TResult>,
    options?: RunTaskOptions,
    errorCallback?: RunTaskErrorCallback
  ) {
    if (!this._io) throw new Error("No IO");
    if (!this._connectionKey) throw new Error("No connection key");

    return this._io.runTask<TResult>(
      key,
      (task, io) => {
        if (!this._client) throw new Error("No client");
        return callback(this._client, task, io);
      },
      { icon: "airtable", ...(options ?? {}), connectionKey: this._connectionKey },
      errorCallback
    );
  }

  base(baseId: string) {
    return new Base(this.runTask.bind(this), baseId);
  }

  onTable(params: {
    baseId: string;
    tableId: string;
    changeTypes?: WebhookChangeType[];
    dataTypes?: WebhookDataType[];
  }) {
    return createTrigger(this.source, events.onTableChanged, params, {
      changeTypes: params.changeTypes,
      dataTypes: ["tableData", "tableFields", "tableMetadata"],
    });
  }

  webhooks() {
    return new Webhooks(this.runTask.bind(this));
  }
}
