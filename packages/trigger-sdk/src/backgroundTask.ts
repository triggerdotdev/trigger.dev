import { BackgroundTaskMetadata, LogLevel } from "@trigger.dev/core";
import { z } from "zod";
import { TriggerClient } from "./triggerClient";
import { slugifyId } from "./utils";

export type BackgroundTaskOptions<TPayload = any> = {
  id: string;
  name: string;
  version: string;
  schema?: z.Schema<TPayload>;
  logLevel?: LogLevel;

  cpu?: 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128;
  memory?: 256 | 512 | 1024 | 2048 | 4096 | 8192 | 16384 | 32768;
  concurrency?: number;

  secrets?: {
    [key: string]: string;
  };

  enabled?: boolean;
  run: (payload: TPayload) => Promise<any>;
};

export class BackgroundTask<TPayload = any> {
  readonly options: BackgroundTaskOptions<TPayload>;

  client: TriggerClient;

  constructor(client: TriggerClient, options: BackgroundTaskOptions<TPayload>) {
    this.client = client;
    this.options = options;
    this.#validate();

    client.attachBackgroundTask(this);
  }

  get id() {
    return slugifyId(this.options.id);
  }

  get enabled() {
    return typeof this.options.enabled === "boolean" ? this.options.enabled : true;
  }

  get name() {
    return this.options.name;
  }

  get schema() {
    return this.options.schema;
  }

  get version() {
    return this.options.version;
  }

  get logLevel() {
    return this.options.logLevel;
  }

  public async invoke(key: string, payload: TPayload): Promise<any> {}

  toJSON(): BackgroundTaskMetadata {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      enabled: this.enabled,
      cpu: this.options.cpu ?? 1,
      memory: this.options.memory ?? 256,
      concurrency: this.options.concurrency ?? 1,
      secrets: this.options.secrets ?? {},
    };
  }

  // Make sure the id is valid (must only contain alphanumeric characters and dashes)
  // Make sure the version is valid (must be a valid semver version)
  #validate() {
    if (!this.version.match(/^(\d+)\.(\d+)\.(\d+)$/)) {
      throw new Error(
        `Invalid job version: "${this.version}". BackgroundTask versions must be valid semver versions.`
      );
    }
  }
}
