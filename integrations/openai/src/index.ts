import {
  retry,
  type ConnectionAuth,
  type IO,
  type IOTask,
  type IntegrationTaskKey,
  type Json,
  type RunTaskErrorCallback,
  type RunTaskOptions,
  type TriggerIntegration,
} from "@trigger.dev/sdk";
import OpenAIApi from "openai";
import { Chat } from "./chat";
import { Completions } from "./completions";
import { Edits } from "./edits";
import { Embeddings } from "./embeddings";
import { Files } from "./files";
import { FineTunes } from "./fineTunes";
import { Images } from "./images";
import { Models } from "./models";
import { OpenAIIntegrationOptions } from "./types";
import { Beta } from "./beta";

export type OpenAIRunTask = InstanceType<typeof OpenAI>["runTask"];

export class OpenAI implements TriggerIntegration {
  // @internal
  private _options: OpenAIIntegrationOptions;
  // @internal
  private _client?: OpenAIApi;
  // @internal
  private _io?: IO;
  // @internal
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
    this._options = options;

    this.native = new OpenAIApi({
      apiKey: options.apiKey,
      organization: options.organization,
      baseURL: options.baseURL,
      defaultHeaders: options.defaultHeaders,
      defaultQuery: options.defaultQuery,
      maxRetries: 0,
    });
  }

  get authSource() {
    return "LOCAL" as const;
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const apiKey = this._options.apiKey ?? auth?.accessToken;

    if (!apiKey) {
      throw new Error(
        `Can't initialize OpenAI integration (${this._options.id}) as apiKey was undefined`
      );
    }

    const openai = new OpenAI(this._options);
    openai._io = io;
    openai._connectionKey = connectionKey;
    openai._client = new OpenAIApi({
      apiKey,
      organization: this._options.organization,
      baseURL: this._options.baseURL ?? "https://api.openai.com/v1",
      defaultHeaders: this._options.defaultHeaders,
      defaultQuery: this._options.defaultQuery,
      maxRetries: 0,
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
    if (!this._io)
      throw new Error(
        "Issue with running task: IO not found. It's possible that you forgot to prefix openai with io. inside a run"
      );
    if (!this._connectionKey) throw new Error("No connection key");
    return this._io.runTask(
      key,
      (task, io) => {
        if (!this._client) throw new Error("No client");
        return callback(this._client, task, io);
      },
      {
        icon: this._options.icon ?? "openai",
        retry: retry.exponentialBackoff,
        ...(options ?? {}),
        connectionKey: this._connectionKey,
      },
      errorCallback
    );
  }

  get models() {
    return new Models(this.runTask.bind(this));
  }

  get completions() {
    return new Completions(this.runTask.bind(this), this._options);
  }

  get beta() {
    return new Beta(this.runTask.bind(this), this._options);
  }

  get chat() {
    return new Chat(this.runTask.bind(this), this._options);
  }

  get edits() {
    return new Edits(this.runTask.bind(this));
  }

  get images() {
    return new Images(this.runTask.bind(this), this._options);
  }

  get embeddings() {
    return new Embeddings(this.runTask.bind(this));
  }

  get files() {
    return new Files(this.runTask.bind(this), this._options);
  }

  get fineTunes() {
    return this.fineTuning;
  }

  get fineTuning() {
    return new FineTunes(this.runTask.bind(this));
  }

  /**
   * @deprecated Please use openai.models.retrieve instead
   */
  retrieveModel = this.models.retrieve;

  /**
   * @deprecated Please use openai.models.list instead
   */
  listModels = this.models.list;

  /**
   * @deprecated Please use openai.models.delete instead
   */
  deleteModel = this.models.delete;

  /**
   * @deprecated Please use openai.models.delete instead
   */
  deleteFineTune = this.models.delete;

  /**
   * @deprecated Please use openai.completions.create instead
   */
  createCompletion = this.completions.create;

  /**
   * @deprecated Please use openai.chat.completions.create instead
   */
  createChatCompletion = this.chat.completions.create;

  /**
   * @deprecated Please use openai.completions.backgroundCreate instead
   */
  async backgroundCreateCompletion(...args: Parameters<typeof this.completions.backgroundCreate>) {
    return this.completions.backgroundCreate(...args);
  }

  /**
   * @deprecated Please use openai.chat.completions.backgroundCreate instead
   */
  async backgroundCreateChatCompletion(
    ...args: Parameters<typeof this.chat.completions.backgroundCreate>
  ) {
    return this.chat.completions.backgroundCreate(...args);
  }

  /**
   * @deprecated Please use openai.edits.create instead
   */
  createEdit = this.edits.create;

  /**
   * @deprecated Please use openai.images.generate instead
   */
  async generateImage(...args: Parameters<typeof this.images.generate>) {
    return this.images.generate(...args);
  }

  /**
   * @deprecated Please use openai.images.create instead
   */
  async createImage(...args: Parameters<typeof this.images.generate>) {
    return this.images.generate(...args);
  }

  /**
   * @deprecated Please use openai.images.edit instead
   */
  async createImageEdit(...args: Parameters<typeof this.images.edit>) {
    return this.images.edit(...args);
  }

  /**
   * @deprecated Please use openai.images.createVariation instead
   */
  async createImageVariation(...args: Parameters<typeof this.images.createVariation>) {
    return this.images.createVariation(...args);
  }

  /**
   * @deprecated Please use openai.embeddings.create instead
   */
  createEmbedding = this.embeddings.create;

  /**
   * @deprecated Please use openai.files.create instead
   */
  createFile = this.files.create;

  /**
   * @deprecated Please use openai.files.list instead
   */
  listFiles = this.files.list;

  /**
   * @deprecated Please use openai.files.create instead
   */
  createFineTuneFile = this.files.createFineTune;

  /**
   * @deprecated Please use openai.fineTuning.create instead
   */
  createFineTune = this.fineTunes.create;

  /**
   * @deprecated Please use openai.fineTuning.list instead
   */
  listFineTunes = this.fineTunes.list;

  /**
   * @deprecated Please use openai.fineTuning.retrieve instead
   */
  retrieveFineTune = this.fineTunes.retrieve;

  /**
   * @deprecated Please use openai.fineTuning.cancel instead
   */
  cancelFineTune = this.fineTunes.cancel;

  /**
   * @deprecated Please use openai.fineTuning.listEvents instead
   */
  listFineTuneEvents = this.fineTunes.listEvents;

  /**
   * Creates a job that fine-tunes a specified model from a given dataset.
   *
   * Response includes details of the enqueued job including job status and the name
   * of the fine-tuned models once complete.
   *
   * [Learn more about fine-tuning](https://platform.openai.com/docs/guides/fine-tuning)
   *
   * @deprecated Please use openai.fineTuning.jobs.create instead
   */
  createFineTuningJob = this.fineTunes.jobs.create;

  /**
   * @deprecated Please use openai.fineTuning.jobs.retrieve instead
   */
  retrieveFineTuningJob = this.fineTunes.jobs.retrieve;

  /**
   * @deprecated Please use openai.fineTuning.jobs.cancel instead
   */
  cancelFineTuningJob = this.fineTunes.jobs.cancel;

  /**
   * @deprecated Please use openai.fineTuning.jobs.listEvents instead
   */
  listFineTuningJobEvents = this.fineTunes.jobs.listEvents;

  /**
   * @deprecated Please use openai.fineTuning.jobs.list instead
   */
  listFineTuningJobs = this.fineTunes.jobs.list;
}
