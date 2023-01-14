import { TriggerEvent } from "@trigger.dev/sdk";
import { github } from "@trigger.dev/providers";

export function repoIssueEvent(params: {
  repo: string;
}): TriggerEvent<typeof github.schemas.IssueEventSchema> {
  return {
    metadata: {
      type: "WEBHOOK",
      service: "github",
      name: "issues",
      filter: {
        service: ["github"],
        payload: {
          repository: {
            full_name: [params.repo],
          },
        },
        event: ["issues"],
      },
      source: github.schemas.WebhookSourceSchema.parse({
        subresource: "repository",
        scopes: ["repo"],
        repo: params.repo,
        events: ["issues"],
      }),
    },
    schema: github.schemas.IssueEventSchema,
  };
}

export function orgIssueEvent(params: {
  org: string;
}): TriggerEvent<typeof github.schemas.IssueEventSchema> {
  return {
    metadata: {
      type: "WEBHOOK",
      service: "github",
      name: "issues",
      filter: {
        service: ["github"],
        payload: {
          organizaton: {
            name: [params.org],
          },
        },
        event: ["issues"],
      },
      source: github.schemas.WebhookSourceSchema.parse({
        subresource: "organization",
        scopes: ["repo"],
        org: params.org,
        events: ["issues"],
      }),
    },
    schema: github.schemas.IssueEventSchema,
  };
}
