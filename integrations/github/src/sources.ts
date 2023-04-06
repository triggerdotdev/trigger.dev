import { ExternalSource } from "@trigger.dev/sdk/externalSource";
import { clientFactory } from "./client";
import { metadata } from "./metadata";

export function repositoryWebhookSource(params: {
  repo: string;
  events: string[];
}) {
  return new ExternalSource("http", metadata, {
    id: `github.repo.${params.repo}.webhook`,
    clientFactory,
    register: async (client, options) => {},
    handler: async (client, req) => {
      return [];
    },
  });
}
