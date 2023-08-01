import { WebClient } from "@slack/web-api";
import type { IntegrationClient, TriggerIntegration } from "@trigger.dev/sdk";
import { joinConversation, postMessage } from "./tasks";

const tasks = {
  postMessage,
  joinConversation,
};

export type SlackIntegrationOptions = {
  id: string;
};

export class Slack implements TriggerIntegration<IntegrationClient<WebClient, typeof tasks>> {
  client: IntegrationClient<WebClient, typeof tasks>;

  constructor(private options: SlackIntegrationOptions) {
    this.client = {
      tasks,
      usesLocalAuth: false,
      clientFactory: (auth) => {
        return new WebClient(auth.accessToken);
      },
    };
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "slack", name: "Slack.com" };
  }
}
