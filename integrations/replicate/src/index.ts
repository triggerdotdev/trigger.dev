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
import ReplicateClient, { Page, Prediction } from "replicate";

import { Predictions } from "./predictions";
import { Models } from "./models";
import { Trainings } from "./trainings";
import { Collections } from "./collections";
import { ReplicateReturnType } from "./types";
import { Deployments } from "./deployments";

export type ReplicateIntegrationOptions = {
  id: string;
  apiKey: string;
};

export type ReplicateRunTask = InstanceType<typeof Replicate>["runTask"];

export class Replicate implements TriggerIntegration {
  private _options: ReplicateIntegrationOptions;
  private _client?: any;
  private _io?: IO;
  private _connectionKey?: string;

  constructor(private options: ReplicateIntegrationOptions) {
    if (Object.keys(options).includes("apiKey") && !options.apiKey) {
      throw `Can't create Replicate integration (${options.id}) as apiKey was undefined`;
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
    return { id: "replicate", name: "Replicate" };
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const replicate = new Replicate(this._options);
    replicate._io = io;
    replicate._connectionKey = connectionKey;
    replicate._client = this.createClient(auth);
    return replicate;
  }

  createClient(auth?: ConnectionAuth) {
    return new ReplicateClient({
      auth: this._options.apiKey,
    });
  }

  runTask<T, TResult extends Json<T> | void>(
    key: IntegrationTaskKey,
    callback: (client: ReplicateClient, task: IOTask, io: IO) => Promise<TResult>,
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
        icon: "replicate",
        retry: retry.standardBackoff,
        ...(options ?? {}),
        connectionKey: this._connectionKey,
      },
      errorCallback ?? onError
    );
  }

  get collections() {
    return new Collections(this.runTask.bind(this));
  }

  get deployments() {
    return new Deployments(this.runTask.bind(this));
  }

  get models() {
    return new Models(this.runTask.bind(this));
  }

  get predictions() {
    return new Predictions(this.runTask.bind(this));
  }

  get trainings() {
    return new Trainings(this.runTask.bind(this));
  }

  /** Paginate through a list of results. */
  async *paginate<T>(
    task: (key: string) => Promise<Page<T>>,
    key: IntegrationTaskKey,
    counter: number = 0
  ): AsyncGenerator<T[]> {
    const boundTask = task.bind(this as any);

    const page = await boundTask(`${key}-${counter}`);
    yield page.results;

    if (page.next) {
      const nextStep = counter++;

      const nextPage = () => {
        return this.request<Page<T>>(`${key}-${nextStep}`, {
          route: page.next!,
          options: { method: "GET" },
        });
      };

      yield* this.paginate(nextPage, key, nextStep);
    }
  }

  /** Auto-paginate and return all results. */
  async getAll<T>(
    task: (key: string) => Promise<Page<T>>,
    key: IntegrationTaskKey
  ): ReplicateReturnType<T[]> {
    const allResults: T[] = [];

    for await (const results of this.paginate(task, key)) {
      allResults.push(...results);
    }

    return allResults;
  }

  /** Make a request to the Replicate API. */
  request<T = any>(
    key: IntegrationTaskKey,
    params: {
      route: string | URL;
      options: Parameters<ReplicateClient["request"]>[1];
    }
  ): ReplicateReturnType<T> {
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

  /** Run a model and await the result. */
  run(
    key: IntegrationTaskKey,
    params: {
      identifier: Parameters<ReplicateClient["run"]>[0];
    } & Omit<
      Parameters<ReplicateClient["run"]>[1],
      "webhook" | "webhook_events_filter" | "wait" | "signal"
    >
  ): ReplicateReturnType<Prediction> {
    const { identifier, ...paramsWithoutIdentifier } = params;

    // see: https://github.com/replicate/replicate-javascript/blob/4b0d9cb0e226fab3d3d31de5b32261485acf5626/index.js#L102

    const namePattern = /[a-zA-Z0-9]+(?:(?:[._]|__|[-]*)[a-zA-Z0-9]+)*/;
    const pattern = new RegExp(
      `^(?<owner>${namePattern.source})/(?<name>${namePattern.source}):(?<version>[0-9a-fA-F]+)$`
    );

    const match = identifier.match(pattern);

    if (!match || !match.groups) {
      throw new Error('Invalid version. It must be in the format "owner/name:version"');
    }

    const { version } = match.groups;

    return this.predictions.createAndAwait(key, { ...paramsWithoutIdentifier, version });
  }

  // TODO: wait(prediction) - needs polling
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly request: Request,
    readonly response: Response
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function isReplicateApiError(error: unknown): error is ApiError {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const apiError = error as ApiError;

  return (
    apiError.name === "ApiError" &&
    apiError.request instanceof Request &&
    apiError.response instanceof Response
  );
}

function shouldRetry(method: string, status: number) {
  return status === 429 || (method === "GET" && status >= 500);
}

export function onError(error: unknown): ReturnType<RunTaskErrorCallback> {
  if (!isReplicateApiError(error)) {
    return;
  }

  if (!shouldRetry(error.request.method, error.response.status)) {
    return {
      skipRetrying: true,
    };
  }

  // see: https://github.com/replicate/replicate-javascript/blob/4b0d9cb0e226fab3d3d31de5b32261485acf5626/lib/util.js#L43

  const retryAfter = error.response.headers.get("retry-after");

  if (retryAfter) {
    const resetDate = new Date(retryAfter);

    if (!Number.isNaN(resetDate.getTime())) {
      return {
        retryAt: resetDate,
        error,
      };
    }
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
