import {
  TriggerIntegration,
  RunTaskOptions,
  IO,
  IOTask,
  IntegrationTaskKey,
  RunTaskErrorCallback,
  Json,
  retry,
  ConnectionAuth,
} from "@trigger.dev/sdk";
import { VercelClient } from "./client";

import * as events from "./events";
import { TriggerParams, Webhooks, createTrigger, createWebhookEventSource } from "./webhooks";

export type VercelIntegrationOptions = {
  id: string;
  apiKey?: string;
};

export type VercelRunTask = InstanceType<typeof Vercel>["runTask"];

export class Vercel implements TriggerIntegration {
  private _options: VercelIntegrationOptions;
  private _client?: VercelClient;
  private _io?: IO;
  private _connectionKey?: string;

  constructor(private options: VercelIntegrationOptions) {
    if (Object.keys(options).includes("apiKey") && !options.apiKey) {
      throw `Cannot create Vercel integration (${options.id}) as apiKey was undefined`;
    }

    this._options = options;
  }

  get authSource() {
    return this._options.apiKey ? "LOCAL" : "HOSTED";
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "vercel", name: "Vercel" };
  }

  get source() {
    return createWebhookEventSource(this);
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const vercel = new Vercel(this._options);
    vercel._io = io;
    vercel._connectionKey = connectionKey;
    vercel._client = this.createClient(auth);
    return vercel;
  }

  createClient(auth?: ConnectionAuth) {
    // TODO: implement oauth
    // oauth
    // if (auth) {
    //   return new VercelClient({
    //     auth: auth.accessToken,
    //   });
    // }

    // apiKey auth
    if (this._options.apiKey) {
      return new VercelClient(this._options.apiKey);
    }

    throw new Error("No auth");
  }

  runTask<T, TResult extends Json<T> | void>(
    key: IntegrationTaskKey,
    callback: (client: VercelClient, task: IOTask, io: IO) => Promise<TResult>,
    options?: RunTaskOptions,
    errorCallback?: RunTaskErrorCallback
  ): Promise<TResult> {
    if (!this._io) throw new Error("No IO");
    if (!this._connectionKey) throw new Error("No connection key");

    return this._io.runTask<TResult>(
      key,
      (task, io) => {
        if (!this._client) throw new Error("No client");
        return callback(this._client, task, io);
      },
      {
        icon: "vercel",
        retry: retry.standardBackoff,
        ...(options ?? {}),
        connectionKey: this._connectionKey,
      },
      errorCallback
    );
  }

  // events
  onDeploymentCreated(params: TriggerParams) {
    return createTrigger(this.source, events.onDeploymentCreated, params);
  }

  onDeploymentSucceeded(params: TriggerParams) {
    return createTrigger(this.source, events.onDeploymentSucceeded, params);
  }

  // private, just here to keep webhook logic in a separate file
  get #webhooks() {
    return new Webhooks(this.runTask.bind(this));
  }

  listWebhooks = this.#webhooks.list;
  createWebhook = this.#webhooks.create;
  deleteWebhook = this.#webhooks.delete;
  updateWebhook = this.#webhooks.update;
}
