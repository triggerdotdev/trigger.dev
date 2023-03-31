import { Trigger } from "./triggers";
import { TriggerClient } from "./triggerClient";
import type { TriggerContext } from "./types";
import { LogLevel } from "@trigger.dev/internal";

export type JobOptions<TEventType = any> = {
  id: string;
  name: string;
  version: string;
  trigger: Trigger<TEventType>;
  logLevel?: LogLevel;

  run: (event: TEventType, ctx: TriggerContext) => Promise<any>;
};

export class Job<TEventType = any> {
  options: JobOptions<TEventType>;

  constructor(options: JobOptions<TEventType>) {
    this.options = options;
    this.#validate();
  }

  get id() {
    return this.options.id;
  }

  get name() {
    return this.options.name;
  }

  get trigger() {
    return this.options.trigger;
  }

  get version() {
    return this.options.version;
  }

  registerWith(client: TriggerClient) {
    client.register(this);
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      trigger: this.trigger.toJSON(),
    };
  }

  // Make sure the id is valid (must only contain alphanumeric characters and dashes)
  // Make sure the version is valid (must be a valid semver version)
  #validate() {
    if (!this.id.match(/^[a-zA-Z0-9-]+$/)) {
      throw new Error(
        `Invalid job id: "${this.id}". Job ids must only contain alphanumeric characters and dashes.`
      );
    }

    if (!this.version.match(/^(\d+)\.(\d+)\.(\d+)$/)) {
      throw new Error(
        `Invalid job version: "${this.version}". Job versions must be valid semver versions.`
      );
    }
  }
}
