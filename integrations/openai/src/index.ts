import type {
  ConnectionAuth,
  IO,
  IOTask,
  IntegrationTaskKey,
  Json,
  RunTaskErrorCallback,
  RunTaskOptions,
  TriggerIntegration,
} from "@trigger.dev/sdk";
import OpenAIApi from "openai";
import { Models } from "./models";
import { OpenAIIntegrationOptions } from "./types";

export type OpenAIRunTask = InstanceType<typeof OpenAI>["runTask"];

export class OpenAI implements TriggerIntegration {
  private _options: OpenAIIntegrationOptions;
  private _client?: OpenAIApi;
  private _io?: IO;
  private _connectionKey?: string;

  /**
   * The native OpenAIApi client. This is exposed for use outside of Trigger.dev jobs
   *
   * @example
   * ```ts
   * import { OpenAI } from "@trigger.dev/openai";
   *
   * const openAI = new OpenAI({
   *   id: "my-openai",
   *   apiKey: process.env.OPENAI_API_KEY!,
   * });
   *
   * const response = await openAI.native.completions.create({}); // ...
   * ```
   */
  public readonly native: OpenAIApi;

  constructor(private options: OpenAIIntegrationOptions) {
    if (Object.keys(options).includes("apiKey") && !options.apiKey) {
      throw `Can't create OpenAI integration (${options.id}) as apiKey was undefined`;
    }

    this._options = options;

    this.native = new OpenAIApi({
      apiKey: options.apiKey,
      organization: options.organization,
    });
  }

  get authSource() {
    return "LOCAL" as const;
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const openai = new OpenAI(this._options);
    openai._io = io;
    openai._connectionKey = connectionKey;
    openai._client = new OpenAIApi({
      apiKey: this._options.apiKey,
      organization: this._options.organization,
    });
    return openai;
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "openai", name: "OpenAI" };
  }

  runTask<T, TResult extends Json<T> | void>(
    key: IntegrationTaskKey,
    callback: (client: OpenAIApi, task: IOTask, io: IO) => Promise<TResult>,
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
      { icon: "openai", ...(options ?? {}), connectionKey: this._connectionKey },
      errorCallback
    );
  }

  get models() {
    return new Models(this.runTask.bind(this));
  }
}
