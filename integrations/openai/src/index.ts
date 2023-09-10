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
import { Models } from "./models";
import { OpenAIIntegrationOptions } from "./types";
import { Completions } from "./completions";
import { Chat } from "./chat";
import { Edits } from "./edits";
import { Images } from "./images";
import { Embeddings } from "./embeddings";
import { Files } from "./files";
import { FineTunes } from "./fineTunes";

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
      {
        icon: "openai",
        retry: retry.standardBackoff,
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
    return new Completions(this.runTask.bind(this));
  }

  get chat() {
    return new Chat(this.runTask.bind(this));
  }

  get edits() {
    return new Edits(this.runTask.bind(this));
  }

  get images() {
    return new Images(this.runTask.bind(this));
  }

  get embeddings() {
    return new Embeddings(this.runTask.bind(this));
  }

  get files() {
    return new Files(this.runTask.bind(this));
  }

  get fineTunes() {
    return new FineTunes(this.runTask.bind(this));
  }

  // this provides backwards compatibility for the old API
  retrieveModel = this.models.retrieve;
  listModels = this.models.list;
  deleteModel = this.models.delete;
  deleteFineTune = this.models.delete;
  createCompletion = this.completions.create;
  backgroundCreateCompletion = this.completions.backgroundCreate;
  createChatCompletion = this.chat.completions.create;
  backgroundCreateChatCompletion = this.chat.completions.backgroundCreate;

  /**
   * @deprecated The Edits API is deprecated; please use Chat Completions instead.
   */
  createEdit = this.edits.create;
  generateImage = this.images.generate;
  createImage = this.images.generate;
  createImageEdit = this.images.edit;
  createImageVariation = this.images.createVariation;
  createEmbedding = this.embeddings.create;
  createFile = this.files.create;
  listFiles = this.files.list;
  createFineTuneFile = this.files.createFineTune;
  createFineTune = this.fineTunes.create;
  listFineTunes = this.fineTunes.list;
  retrieveFineTune = this.fineTunes.retrieve;
  cancelFineTune = this.fineTunes.cancel;
  listFineTuneEvents = this.fineTunes.listEvents;

  /**
   * Creates a job that fine-tunes a specified model from a given dataset.
   *
   * Response includes details of the enqueued job including job status and the name
   * of the fine-tuned models once complete.
   *
   * [Learn more about fine-tuning](https://platform.openai.com/docs/guides/fine-tuning)
   */
  createFineTuningJob = this.fineTunes.jobs.create;
  retrieveFineTuningJob = this.fineTunes.jobs.retrieve;
  cancelFineTuningJob = this.fineTunes.jobs.cancel;
  listFineTuningJobEvents = this.fineTunes.jobs.listEvents;
  listFineTuningJobs = this.fineTunes.jobs.list;
}
