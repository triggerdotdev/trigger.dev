import { TriggerEvent } from "@trigger.dev/sdk";
import { createWebhookConfig, github } from "internal-integrations";

type IssueEventParams = {
  repo: string;
};

export function issueEvent(
  params: IssueEventParams
): TriggerEvent<typeof github.schemas.IssueEventSchema> {
  return {
    type: "WEBHOOK",
    config: createWebhookConfig(github.schemas.WebhookSchema, "github.issue", {
      events: ["issues"],
      params,
      scopes: ["repo"],
    }),
    schema: github.schemas.IssueEventSchema,
  };
}

export function issueCommentEvent(
  params: IssueEventParams
): TriggerEvent<typeof github.schemas.IssueEventSchema> {
  return {
    type: "WEBHOOK",
    config: createWebhookConfig(
      github.schemas.WebhookSchema,
      "github.issueComment",
      {
        events: ["issue_comment"],
        params,
        scopes: ["repo"],
      }
    ),
    schema: github.schemas.IssueEventSchema,
  };
}
