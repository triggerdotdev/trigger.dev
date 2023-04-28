import { WebClient } from "@slack/web-api";
import type { Connection } from "@trigger.dev/sdk";
import { clientFactory } from "./client";
import { metadata } from "./metadata";
import { postMessage } from "./tasks";

const tasks = {
  postMessage,
};

export type SlackIntegrationOptions = {
  id: string;
};

export const slack = ({ id }: SlackIntegrationOptions) => {
  return {
    id,
    metadata,
    tasks,
    usesLocalAuth: false,
    clientFactory,
  } satisfies Connection<WebClient, typeof tasks>;
};
