import { Prettify } from "@trigger.dev/integration-kit";
import {
  Json,
  retry,
  type ConnectionAuth,
  type IO,
  type IOTask,
  type IntegrationTaskKey,
  type RunTaskErrorCallback,
  type RunTaskOptions,
  type TriggerIntegration,
} from "@trigger.dev/sdk";
import AirtableSDK from "airtable";
import { Base } from "./base";
import { Webhooks, createWebhookSource } from "./webhooks";

export * from "./base";
export * from "./types";

export type AirtableIntegrationOptions = {
  /** An ID for this client  */
  id: string;
  /** Use this if you pass in a [Personal Access Token](https://airtable.com/developers/web/guides/personal-access-tokens). If omitted, it will use OAuth.  */
  token?: string;
};

export type AirtableRunTask = InstanceType<typeof Airtable>["runTask"];

export class Airtable implements TriggerIntegration {
  // @internal
  private _options: AirtableIntegrationOptions;
  // @internal
  private _client?: AirtableSDK;
  // @internal
  private _io?: IO;
  // @internal
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
    return createWebhookSource(this);
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const airtable = new Airtable(this._options);
    airtable._io = io;
    airtable._connectionKey = connectionKey;
    airtable._client = this.createClient(auth);
    return airtable;
  }

  createClient(auth?: ConnectionAuth) {
    if (auth) {
      return new AirtableSDK({
        apiKey: auth.accessToken,
      });
    }

    if (this._options.token) {
      return new AirtableSDK({
        apiKey: this._options.token,
      });
    }

    throw new Error("No auth");
  }

  runTask<T, TResult extends Json<T> | void>(
    key: IntegrationTaskKey,
    callback: (client: AirtableSDK, task: IOTask, io: IO) => Promise<TResult>,
    options?: RunTaskOptions,
    errorCallback?: RunTaskErrorCallback
  ): Promise<TResult> {
    if (!this._io) throw new Error("No IO");
    if (!this._connectionKey) throw new Error("No connection key");

    return this._io.runTask(
      key,
      (task, io) => {
        if (!this._client) throw new Error("No client");
        return callback(this._client, task, io);
      },
      {
        icon: "airtable",
        retry: retry.standardBackoff,
        ...(options ?? {}),
        connectionKey: this._connectionKey,
      },
      errorCallback ?? onError
    );
  }

  base(baseId: string) {
    return new Base(this.runTask.bind(this), baseId);
  }

  //todo these require batch support because they send too many events
  // onTableChanges(params: {
  //   baseId: string;
  //   tableId?: string;
  //   changeTypes?: WebhookChangeType[];
  //   dataTypes?: WebhookDataType[];
  // }) {
  //   return createWebhookTrigger(this.source, events.onTableChanged, params, {
  //     changeTypes: params.changeTypes ?? ["add", "remove", "update"],
  //     dataTypes: ["tableData", "tableFields", "tableMetadata"],
  //   });
  // }

  webhooks() {
    return new Webhooks(this.runTask.bind(this));
  }
}

function isAirtableApiError(error: unknown): error is AirtableSDK.Error {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const airtableError = error as AirtableSDK.Error;

  return (
    typeof airtableError.error === "string" &&
    typeof airtableError.message === "string" &&
    typeof airtableError.statusCode === "number"
  );
}

export function onError(error: unknown): ReturnType<RunTaskErrorCallback> {
  if (!isAirtableApiError(error)) {
    return;
  }

  if (error.statusCode === 429) {
    // see: https://airtable.com/developers/web/api/rate-limits
    return {
      retryAt: new Date(Date.now() + 30 * 1000),
    };
  }

  if (error.statusCode >= 400 && error.statusCode < 500) {
    // see: https://airtable.com/developers/web/api/errors#user-error-codes
    return {
      skipRetrying: true,
    };
  }
}
