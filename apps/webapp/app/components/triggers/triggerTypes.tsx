import CustomEvent from "../../assets/images/triggers/custom-event.png";
import HttpEndpoint from "../../assets/images/triggers/http-endpoint.png";
import Schedule from "../../assets/images/triggers/schedule.png";
import EventBridge from "../../assets/images/triggers/event-bridge.png";
import HttpPolling from "../../assets/images/triggers/http-polling.png";

import {
  BarsArrowDownIcon,
  CalendarDaysIcon,
  DocumentTextIcon,
} from "@heroicons/react/24/outline";
import type { ReactNode } from "react";
import type { Workflow } from "~/models/workflow.server";
import type { Provider } from "internal-providers";
import { ApiLogoIcon } from "../code/ApiLogoIcon";

type TriggerType = Workflow["type"];

const styleClass = "h-6 w-6 text-slate-400";
export const triggerInfo: Record<
  TriggerType,
  { label: string; icon: ReactNode }
> = {
  CUSTOM_EVENT: {
    label: "Custom event",
    icon: <BarsArrowDownIcon className={styleClass} />,
  },
  WEBHOOK: {
    label: "Webhook",
    icon: <BarsArrowDownIcon className={styleClass} />,
  },
  HTTP_ENDPOINT: {
    label: "HTTP endpoint",
    icon: <DocumentTextIcon className={styleClass} />,
  },
  SCHEDULE: {
    label: "Scheduled",
    icon: <CalendarDaysIcon className={styleClass} />,
  },
  EVENT_BRIDGE: {
    label: "Event bridge",
    icon: <BarsArrowDownIcon className={styleClass} />,
  },
  HTTP_POLLING: {
    label: "HTTP polling",
    icon: <DocumentTextIcon className={styleClass} />,
  },
} as const;

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
    default:
      return type;
  }
}

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
    default:
      return null;
  }
}
