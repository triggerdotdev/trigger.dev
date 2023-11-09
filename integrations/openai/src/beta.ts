import { Assistants } from "./assistants";
import { OpenAIRunTask } from "./index";
import { Threads } from "./threads";
import { OpenAIIntegrationOptions } from "./types";

export class Beta {
  constructor(
    private runTask: OpenAIRunTask,
    private options: OpenAIIntegrationOptions
  ) {}

  get assistants() {
    return new Assistants(this.runTask.bind(this), this.options);
  }

  get threads() {
    return new Threads(this.runTask.bind(this), this.options);
  }
}
