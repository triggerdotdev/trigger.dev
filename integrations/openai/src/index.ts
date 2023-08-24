import type { IntegrationClient, TriggerIntegration } from "@trigger.dev/sdk";
import OpenAIApi from "openai";
import * as tasks from "./tasks";
import { OpenAIIntegrationOptions } from "./types";

export class OpenAI implements TriggerIntegration<IntegrationClient<OpenAIApi, typeof tasks>> {
  client: IntegrationClient<OpenAIApi, typeof tasks>;

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

    this.native = new OpenAIApi({
      apiKey: options.apiKey,
      organization: options.organization,
    });

    this.client = {
      tasks,
      usesLocalAuth: true,
      client: this.native,
      auth: {
        apiKey: options.apiKey,
        organization: options.organization,
      },
    };
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "openai", name: "OpenAI" };
  }
}
