import {
  BarsArrowDownIcon,
  CalendarDaysIcon,
  DocumentTextIcon,
} from "@heroicons/react/24/outline";
import type { TriggerMetadata } from "@trigger.dev/common-schemas";
import type { ReactNode } from "react";

type TriggerType = TriggerMetadata["type"];

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
} as const;
