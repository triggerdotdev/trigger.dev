import type {
  ConnectionAuth,
  IO,
  IOTask,
  Json,
  RunTaskErrorCallback,
  RunTaskOptions,
  TriggerIntegration,
} from "@trigger.dev/sdk";
import { IntegrationTaskKey, retry } from "@trigger.dev/sdk";

type DummyIntegrationOptions = {
  id: string;
};

export class DummyClient {
  methodOne() {}
  methodTwo() {}
}

export class Dummy implements TriggerIntegration {
  private _client?: DummyClient;
  private _io?: IO;
  private _connectionKey?: string;

  constructor(private options: DummyIntegrationOptions) {}

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "dummy", name: "Dummy" };
  }

  get authSource() {
    return "LOCAL" as const;
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const dummy = new Dummy(this.options);
    dummy._io = io;
    dummy._connectionKey = connectionKey;
    dummy._client = new DummyClient();
    return dummy;
  }

  runTask<T, TResult extends Json<T> | void>(
    key: IntegrationTaskKey,
    callback: (client: DummyClient, task: IOTask, io: IO) => Promise<TResult>,
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
        icon: "dummy",
        retry: retry.standardBackoff,
        ...(options ?? {}),
        connectionKey: this._connectionKey,
      },
      errorCallback
    );
  }

  taskOne(key: IntegrationTaskKey, params: Record<string, any>): Promise<void> {
    return this.runTask(
      key,
      async (client, task) => {
        return client.methodOne();
      },
      {
        name: "Task One",
        params,
      }
    );
  }

  taskTwo(key: IntegrationTaskKey, params: Record<string, any>): Promise<void> {
    return this.runTask(
      key,
      async (client, task) => {
        return client.methodTwo();
      },
      {
        name: "Task Two",
        params,
      }
    );
  }
}

function onTaskError(error: unknown) {
  return;
}
