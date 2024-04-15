import { ClockIcon } from "@heroicons/react/20/solid";
import { TaskTriggerSource } from "@trigger.dev/database";
import { TaskIcon } from "~/assets/icons/TaskIcon";

export function TaskTriggerSourceIcon({ source }: { source: TaskTriggerSource }) {
  switch (source) {
    case "STANDARD": {
      return <TaskIcon className="h-4 w-4 text-blue-500" />;
    }
    case "SCHEDULED": {
      return <ClockIcon className="h-4 w-4 text-sun-500" />;
    }
  }
}
