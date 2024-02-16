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
      return classNameForProminence(event.style.prominence);
    }
    case "LOG":
    case "INFO":
    case "DEBUG": {
      return classNameForProminence(event.style.prominence);
    }
    case "WARN": {
      return "text-amber-400";
    }
    case "ERROR": {
      return "text-rose-500";
    }
    default: {
      return classNameForProminence(event.style.prominence);
    }
  }
}

function classNameForProminence(prominence: TaskEventStyle["prominence"]) {
  return prominence === "high" ? "text-bright" : "text-dimmed";
}
