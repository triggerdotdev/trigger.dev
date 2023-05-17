import { WebClient } from "@slack/web-api";
import type { IntegrationClient, TriggerIntegration } from "@trigger.dev/sdk";
import { clientFactory } from "./client";
import { postMessage } from "./tasks";

const tasks = {
  postMessage,
};

export type SlackIntegrationOptions = {
  id: string;
};

export class Slack
  implements TriggerIntegration<IntegrationClient<WebClient, typeof tasks>>
{
  client: IntegrationClient<WebClient, typeof tasks>;

  constructor(private options: SlackIntegrationOptions) {
    this.client = {
      tasks,
      usesLocalAuth: false,
      clientFactory,
    };
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { key: "slack", title: "Slack.com", icon: "slack" };
  }
}
