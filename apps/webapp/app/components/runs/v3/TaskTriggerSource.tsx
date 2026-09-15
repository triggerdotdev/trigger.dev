import type { TaskTriggerSource } from "@trigger.dev/database";
import { ClockIcon } from "~/assets/icons/ClockIcon";
import { CubeSparkleIcon } from "~/assets/icons/CubeSparkleIcon";
import { TaskIconSmall } from "~/assets/icons/TaskIcon";
import { WebhookIcon } from "~/assets/icons/WebhookIcon";
import { cn } from "~/utils/cn";

export function TaskTriggerSourceIcon({
  source,
  className,
}: {
  source: TaskTriggerSource;
  className?: string;
}) {
  switch (source) {
    case "STANDARD": {
      return <TaskIconSmall className={cn("size-4.5 min-w-4.5 text-tasks", className)} />;
    }
    case "SCHEDULED": {
      return <ClockIcon className={cn("size-4.5 min-w-4.5 text-schedules", className)} />;
    }
    case "AGENT": {
      return <CubeSparkleIcon className={cn("size-4.5 min-w-4.5 text-agents", className)} />;
    }
    case "WEBHOOK": {
      return (
        <WebhookIcon className={cn("size-[1.125rem] min-w-[1.125rem] text-webhooks", className)} />
      );
    }
  }
}

export function taskTriggerSourceDescription(source: TaskTriggerSource) {
  switch (source) {
    case "STANDARD": {
      return "Standard task";
    }
    case "SCHEDULED": {
      return "Scheduled task";
    }
    case "AGENT": {
      return "Agent task";
    }
    case "WEBHOOK": {
      return "Webhook task";
    }
  }
}
