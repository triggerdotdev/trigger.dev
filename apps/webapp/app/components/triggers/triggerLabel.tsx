import type { Workflow } from "~/models/workflow.server";

type TriggerType = Workflow["type"];

export function triggerLabel(type: TriggerType) {
  switch (type) {
    case "CUSTOM_EVENT":
      return "Custom event";
    case "WEBHOOK":
      return "Webhook";
    case "HTTP_ENDPOINT":
      return "HTTP endpoint";
    case "SCHEDULE":
      return "Scheduled";
    case "INTEGRATION_WEBHOOK":
      return "Webhook";
    case "SLACK_INTERACTION":
      return "Slack interaction";
    default:
      return type;
  }
}
