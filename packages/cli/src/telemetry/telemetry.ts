import { PostHog } from "posthog-node";
import { InitCommandOptions } from "../commands/init.js";
import { nanoid } from "nanoid";
import { getVersion } from "../utils/getVersion.js";

//todo update this to the PROD key: phc_hwYmedO564b3Ik8nhA4Csrb5SueY0EwFJWCbseGwWW
const postHogApiKey = "phc_HBGZden3ls3SinTqYOdZkFct4Rn0aarqUzrodYQ7exE";

export class TelemetryClient {
  #client: PostHog;
  #sessionId: string;
  #version: string;

  constructor() {
    this.#client = new PostHog(postHogApiKey, {
      host: "https://app.posthog.com",
      flushAt: 1,
    });
    this.#sessionId = `cli-${nanoid()}`;
    this.#version = getVersion();
  }

  identify(organizationId: string, projectId: string, userId?: string) {
    if (userId) {
      this.#client.alias({
        distinctId: userId,
        alias: this.#sessionId,
      });
    }

    this.#client.groupIdentify({
      groupType: "organization",
      groupKey: organizationId,
    });

    this.#client.groupIdentify({
      groupType: "project",
      groupKey: projectId,
    });
  }

  init = {
    started: (options: InitCommandOptions) => {
      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli init started",
        properties: this.#initProperties(options),
      });
    },
    isNextJsProject: (
      isNextJsProject: boolean,
      options: InitCommandOptions
    ) => {
      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli init nextjsproject",
        properties: { ...this.#initProperties(options), isNextJsProject },
      });
    },
  };

  #initProperties(options: InitCommandOptions) {
    return {
      version: this.#version,
      hadApiKey: options.apiKey !== undefined,
      triggerUrl: options.triggerUrl,
      endpointSlug: options.endpointSlug,
      apiUrl: options.apiUrl,
    };
  }
}
