import {
  BarsArrowDownIcon,
  CalendarDaysIcon,
  DocumentTextIcon,
} from "@heroicons/react/24/outline";
import type { ReactNode } from "react";
import type { Workflow } from "~/models/workflow.server";

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

export function triggerTypeIcon(type: TriggerType, className?: string) {
  switch (type) {
    case "CUSTOM_EVENT":
      return <BarsArrowDownIcon className={className} />;
    case "WEBHOOK":
      return <BarsArrowDownIcon className={className} />;
    case "HTTP_ENDPOINT":
      return <DocumentTextIcon className={className} />;
    case "SCHEDULE":
      return <CalendarDaysIcon className={className} />;
    default:
      return null;
  }
}
