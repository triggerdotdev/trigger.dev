import type { IntegrationClient, TriggerIntegration } from "@trigger.dev/sdk";
import { PlainClient } from "@team-plain/typescript-sdk";
import { tasks } from "./tasks";
import { PlainSDK } from "./types";

export type PlainIntegrationOptions = {
  id: string;
  apiKey: string;
  apiUrl?: string;
};

type PlainIntegration = TriggerIntegration<PlainIntegrationClient>;

type PlainIntegrationClient = IntegrationClient<PlainSDK, typeof tasks>;

export class Plain implements PlainIntegration {
  client: PlainIntegrationClient;

  constructor(private options: PlainIntegrationOptions) {
    if (Object.keys(options).includes("apiKey") && !options.apiKey) {
      throw new Error(`Plain integration (${options.id}) apiKey was undefined`);
    }

    this.client = {
      tasks,
      usesLocalAuth: true,
      client: new PlainClient({
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
      }),
      auth: {
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
      },
    };
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "plain", name: "Plain.com" };
  }
}

export {
  ComponentBadgeColor,
  ComponentDividerSpacingSize,
  ComponentPlainTextColor,
  ComponentPlainTextSize,
  ComponentSpacerSize,
  ComponentTextColor,
  ComponentTextSize,
} from "@team-plain/typescript-sdk";
