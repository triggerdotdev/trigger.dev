import { TaskEventStyle } from "@trigger.dev/core/v3";
import { TaskEventLevel } from "@trigger.dev/database";

type Event = {
  isError: boolean;
  style: TaskEventStyle;
  level: TaskEventLevel;
};

export function eventTextClassName(event: Event) {
  if (event.isError) {
    return "text-rose-500";
  }

  switch (event.level) {
    case "TRACE": {
      return classNameForVariant(event.style.variant);
    }
    case "LOG":
    case "INFO":
    case "DEBUG": {
      return classNameForVariant(event.style.variant);
    }
    case "WARN": {
      return "text-amber-400";
    }
    case "ERROR": {
      return "text-rose-500";
    }
    default: {
      return classNameForVariant(event.style.variant);
    }
  }
}

function classNameForVariant(variant: TaskEventStyle["variant"]) {
  switch (variant) {
    case "task": {
      return "text-blue-500";
    }
    case "attempt": {
      return "text-bright";
    }
    default: {
      return "text-dimmed";
    }
  }
}
