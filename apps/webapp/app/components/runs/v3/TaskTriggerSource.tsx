import { ClockIcon } from "@heroicons/react/20/solid";
import { type TaskTriggerSource } from "@trigger.dev/database";
import { TaskIcon } from "~/assets/icons/TaskIcon";
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
        <div className={cn("grid size-4 place-items-center text-blue-500", className)}>
          <TaskIcon className="size-[87.5%]" />
        </div>
      );
    }
    case "SCHEDULED": {
      return <ClockIcon className={cn("size-4 text-sun-500", className)} />;
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
  }
}
