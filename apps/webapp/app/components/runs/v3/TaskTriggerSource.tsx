import { ClockIcon, CpuChipIcon } from "@heroicons/react/20/solid";
import type { TaskTriggerSource } from "@trigger.dev/database";
import { TaskIconSmall } from "~/assets/icons/TaskIcon";
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
      return (
        <TaskIconSmall className={cn("size-[1.125rem] min-w-[1.125rem] text-tasks", className)} />
      );
    }
    case "SCHEDULED": {
      return (
        <ClockIcon className={cn("size-[1.125rem] min-w-[1.125rem] text-schedules", className)} />
      );
    }
    case "AGENT": {
      return (
        <CpuChipIcon className={cn("size-[1.125rem] min-w-[1.125rem] text-indigo-500", className)} />
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
      return "Agent";
    }
  }
}
