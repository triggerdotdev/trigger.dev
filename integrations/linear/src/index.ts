import {
  ConnectionAuth,
  IO,
  IOTask,
  IntegrationTaskKey,
  Json,
  RunTaskErrorCallback,
  RunTaskOptions,
  TriggerIntegration,
  retry,
} from "@trigger.dev/sdk";
import { LinearClient } from "@linear/sdk";

export type LinearIntegrationOptions = {
  id: string;
  token?: string;
};

export type LinearRunTask = InstanceType<typeof Linear>["runTask"];

class Linear implements TriggerIntegration {
  private _options: LinearIntegrationOptions;
  private _client?: LinearClient;
  private _io?: IO;
  private _connectionKey?: string;

  constructor(private options: LinearIntegrationOptions) {
    if (Object.keys(options).includes("token") && !options.token) {
      throw `Can't create Linear integration (${options.id}) as token was undefined`;
    }

    this._options = options;
  }

  get authSource() {
    return this._options.token ? "LOCAL" : "HOSTED";
  }

  get id() {
    return this._options.id;
  }

  get metadata() {
    return { id: "linear", name: "Linear" };
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const linear = new Linear(this._options);
    linear._io = io;
    linear._connectionKey = connectionKey;
    linear._client = this.createClient(auth);
    return linear;
  }

  createClient(auth?: ConnectionAuth) {
    if (auth) {
      return new LinearClient({
        accessToken: auth.accessToken,
      });
    }

    if (this._options.token) {
      return new LinearClient({
        apiKey: this._options.token,
      });
    }

    throw new Error("No auth");
  }

  runTask<T, TResult extends Json<T> | void>(
    key: IntegrationTaskKey,
    callback: (client: LinearClient, task: IOTask, io: IO) => Promise<TResult>,
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
        icon: "linear",
        retry: retry.standardBackoff,
        ...(options ?? {}),
        connectionKey: this._connectionKey,
      },
      errorCallback
    );
  }
}

// TODO
export function onError(error: unknown) {}

export default Linear;
