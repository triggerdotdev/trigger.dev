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
  Prettify,
} from "@trigger.dev/sdk";
import VercelClient from "vercel";

import * as events from "./events";
import { VercelReturnType, SerializedVercelOutput } from "./types";
import { TriggerParams, Webhooks, createTrigger, createWebhookEventSource } from "./webhooks";

export type VercelIntegrationOptions = {
  id: string;
  apiKey?: string;
};

export type VercelRunTask = InstanceType<typeof Vercel>["runTask"];

export class Vercel implements TriggerIntegration {
  private _options: VercelIntegrationOptions;
  private _client?: any;
  private _io?: IO;
  private _connectionKey?: string;

  constructor(private options: VercelIntegrationOptions) {
    if (Object.keys(options).includes("apiKey") && !options.apiKey) {
      throw `Can't create Vercel integration (${options.id}) as apiKey was undefined`;
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
    // oauth
    if (auth) {
      return new VercelClient({
        auth: auth.accessToken,
      });
    }

    // apiKey auth
    if (this._options.apiKey) {
      return new VercelClient({
        apiKey: this._options.apiKey,
      });
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
      errorCallback ?? onError
    );
  }

  // top-level task

  request<T = any>(
    key: IntegrationTaskKey,
    params: {
      route: string | URL;
      options: Parameters<VercelClient["request"]>[1];
    }
  ): VercelReturnType<T> {
    return this.runTask(
      key,
      async (client) => {
        const response = await client.request(params.route, params.options);

        return response.json();
      },
      {
        name: "Send Request",
        params,
        properties: [
          { label: "Route", text: params.route.toString() },
          ...(params.options.method ? [{ label: "Method", text: params.options.method }] : []),
        ],
        callback: { enabled: true },
      }
    );
  }

  // nested tasks

  get models() {
    return new Models(this.runTask.bind(this));
  }

  // events

  onComment(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onComment, params);
  }

  onCommentCreated(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onCommentCreated, params);
  }

  onCommentRemoved(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onCommentRemoved, params);
  }

  onCommentUpdated(params: TriggerParams = {}) {
    return createTrigger(this.source, events.onCommentUpdated, params);
  }

  // triggers (webhooks)

  // private, just here to keep webhook logic in a separate file
  get #webhooks() {
    return new Webhooks(this.runTask.bind(this));
  }

  webhook = this.#webhooks.webhook;
  webhooks = this.#webhooks.webhooks;

  createWebhook = this.#webhooks.createWebhook;
  deleteWebhook = this.#webhooks.deleteWebhook;
  updateWebhook = this.#webhooks.updateWebhook;
}

class VercelApiError extends Error {
  constructor(
    message: string,
    readonly request: Request,
    readonly response: Response
  ) {
    super(message);
    this.name = "VercelApiError";
  }
}

function isVercelApiError(error: unknown): error is VercelApiError {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const apiError = error as VercelApiError;

  return (
    apiError.name === "VercelApiError" &&
    apiError.request instanceof Request &&
    apiError.response instanceof Response
  );
}

function shouldRetry(method: string, status: number) {
  return status === 429 || (method === "GET" && status >= 500);
}

export function onError(error: unknown): ReturnType<RunTaskErrorCallback> {
  if (!isVercelApiError(error)) {
    return;
  }

  if (!shouldRetry(error.request.method, error.response.status)) {
    return {
      skipRetrying: true,
    };
  }

  const rateLimitRemaining = error.response.headers.get("ratelimit-remaining");
  const rateLimitReset = error.response.headers.get("ratelimit-reset");

  if (rateLimitRemaining === "0" && rateLimitReset) {
    const resetDate = new Date(Number(rateLimitReset) * 1000);

    if (!Number.isNaN(resetDate.getTime())) {
      return {
        retryAt: resetDate,
        error,
      };
    }
  }
}

export const serializeVercelOutput = <T>(obj: T): Prettify<SerializedVercelOutput<T>> => {
  return JSON.parse(JSON.stringify(obj), (key, value) => {
    if (typeof value === "function" || key.startsWith("_")) {
      return undefined;
    }
    return value;
  });
};
