import { PostHog } from "posthog-node";
import { nanoid } from "nanoid";
import { getVersion } from "../utilities/getVersion";

const postHogApiKey = "phc_9aSDbJCaDUMdZdHxxMPTvcj7A9fsl3mCgM1RBPmPsl7";

export class TelemetryClient {
  #client: PostHog;
  #sessionId: string;
  #version: string;

  constructor() {
    this.#client = new PostHog(postHogApiKey, {
      host: "https://eu.posthog.com",
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

  dev = {
    started: (path: string, options: Record<string, string | number | boolean>) => {
      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli_dev_started",
        properties: { ...options, path },
      });
    },
  };
}

export const telemetryClient = new TelemetryClient();
