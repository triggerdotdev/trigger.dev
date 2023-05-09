type TriggerType =
  | "CUSTOM_EVENT"
  | "HTTP_ENDPOINT"
  | "SCHEDULE"
  | "WEBHOOK"
  | "SLACK_INTERACTION";

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
    case "SLACK_INTERACTION":
      return "Slack interaction";
    default:
      return type;
  }
}
