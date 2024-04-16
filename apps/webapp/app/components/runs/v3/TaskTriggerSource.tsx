import { ClockIcon } from "@heroicons/react/20/solid";
import { TaskTriggerSource } from "@trigger.dev/database";
import { TaskIcon } from "~/assets/icons/TaskIcon";

export function TaskTriggerSourceIcon({ source }: { source: TaskTriggerSource }) {
  switch (source) {
    case "STANDARD": {
      return (
        <div className="grid size-4 place-items-center">
          <TaskIcon className="size-3.5 text-blue-500" />
        </div>
      );
    }
    case "SCHEDULED": {
      return <ClockIcon className="size-4 text-sun-500" />;
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
