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
import { Webhooks } from "./webhooks";
import {
  createDeploymentEventSource,
  createDeploymentTrigger,
  createProjectEventSource,
  createProjectTrigger,
} from "./sources";
import { DeploymentTriggerParams, ProjectTriggerParams } from "./types";

export type VercelIntegrationOptions = {
  id: string;
  apiKey: string;
};

export type VercelRunTask = InstanceType<typeof Vercel>["runTask"];

export class Vercel implements TriggerIntegration {
  private _options: VercelIntegrationOptions;
  private _client?: VercelClient;
  private _io?: IO;
  private _connectionKey?: string;

  constructor(private options: VercelIntegrationOptions) {
    if (!options.apiKey) {
      throw `Cannot create Vercel integration (${options.id}) as apiKey was undefined`;
    }

    this._options = options;
  }

  get authSource() {
    return "LOCAL" as const;
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "vercel", name: "Vercel" };
  }

  get sources() {
    return {
      deployment: createDeploymentEventSource(this),
      project: createProjectEventSource(this),
    };
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const vercel = new Vercel(this._options);
    vercel._io = io;
    vercel._connectionKey = connectionKey;
    vercel._client = this.createClient(auth);
    return vercel;
  }

  createClient(auth?: ConnectionAuth) {
    const token = this._options.apiKey ?? auth?.accessToken;
    if (!token) {
      throw `Cannot create Vercel integration (${this._options.id}) as apiKey was undefined`;
    }

    return new VercelClient(token);
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
  onDeploymentCreated(params: DeploymentTriggerParams) {
    return createDeploymentTrigger(this.sources.deployment, events.onDeploymentCreated, params);
  }

  onDeploymentSucceeded(params: DeploymentTriggerParams) {
    return createDeploymentTrigger(this.sources.deployment, events.onDeploymentSucceeded, params);
  }

  onDeploymentCanceled(params: DeploymentTriggerParams) {
    return createDeploymentTrigger(this.sources.deployment, events.onDeploymentCanceled, params);
  }

  onDeploymentError(params: DeploymentTriggerParams) {
    return createDeploymentTrigger(this.sources.deployment, events.onDeploymentError, params);
  }

  onProjectCreated(params: ProjectTriggerParams) {
    return createProjectTrigger(this.sources.project, events.onProjectCreated, params);
  }

  onProjectRemoved(params: ProjectTriggerParams) {
    return createProjectTrigger(this.sources.project, events.onProjectRemoved, params);
  }

  // private, just here to keep webhook logic in a separate file
  get #webhooks() {
    return new Webhooks(this.runTask.bind(this));
  }

  // webhooks
  listWebhooks = this.#webhooks.list;
  createWebhook = this.#webhooks.create;
  deleteWebhook = this.#webhooks.delete;
  updateWebhook = this.#webhooks.update;
}
