import type { Provider } from "@trigger.dev/providers";
import type { Workflow } from "~/models/workflow.server";
import { ApiLogoIcon } from "../code/ApiLogoIcon";
import CustomEvent from "../../assets/images/triggers/custom-event.png";
import HttpEndpoint from "../../assets/images/triggers/http-endpoint.png";
import Schedule from "../../assets/images/triggers/schedule.png";
import Webhook from "../../assets/images/triggers/webhook.png";
import SlackInteraction from "../../assets/images/triggers/slack-interaction.png";
import { triggerLabel } from "./triggerLabel";

type TriggerType = Workflow["type"];

const iconClasses = "h-full w-full";

export function TriggerTypeIcon({
  type,
  provider,
}: {
  type: TriggerType;
  provider?: Provider;
}) {
  if (provider) {
    return (
      <ApiLogoIcon
        integration={provider}
        size="custom"
        className={iconClasses}
      />
    );
  }
  switch (type) {
    case "CUSTOM_EVENT":
      return (
        <img
          src={CustomEvent}
          alt={triggerLabel(type)}
          className={iconClasses}
        />
      );
    case "HTTP_ENDPOINT":
      return (
        <img
          src={HttpEndpoint}
          alt={triggerLabel(type)}
          className={iconClasses}
        />
      );
    case "SCHEDULE":
      return (
        <img src={Schedule} alt={triggerLabel(type)} className={iconClasses} />
      );
    case "WEBHOOK":
      return (
        <img src={Webhook} alt={triggerLabel(type)} className={iconClasses} />
      );
    case "SLACK_INTERACTION":
      return (
        <img
          src={SlackInteraction}
          alt={triggerLabel(type)}
          className={iconClasses}
        />
      );
    default:
      return null;
  }
}
