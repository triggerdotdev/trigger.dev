import { ChevronRightIcon } from "@heroicons/react/20/solid";
import { TaskEventStyle } from "@trigger.dev/core/v3";
import type { TaskEventLevel } from "@trigger.dev/database";
import { Fragment } from "react";
import { cn } from "~/utils/cn";

type SpanTitleProps = {
  message: string;
  isError: boolean;
  style: TaskEventStyle;
  level: TaskEventLevel;
  size: "small" | "large";
};

export function SpanTitle(event: SpanTitleProps) {
  return (
    <span className={cn("inline-flex items-center gap-2", eventTextClassName(event))}>
      {event.message} <SpanAccessory accessory={event.style.accessory} size={event.size} />
    </span>
  );
}

function SpanAccessory({
  accessory,
  size,
}: {
  accessory: TaskEventStyle["accessory"];
  size: SpanTitleProps["size"];
}) {
  if (!accessory) {
    return null;
  }

  switch (accessory.style) {
    case "codepath": {
      return (
        <SpanCodePathAccessory
          accessory={accessory}
          className={cn(size === "large" ? "text-sm" : "text-xs")}
        />
      );
    }
    default: {
      return (
        <div className={cn("flex gap-1")}>
          {accessory.items.map((item, index) => (
            <span key={index} className={cn("inline-flex items-center gap-1")}>
              {item.text}
            </span>
          ))}
        </div>
      );
    }
  }
}

export function SpanCodePathAccessory({
  accessory,
  className,
}: {
  accessory: NonNullable<TaskEventStyle["accessory"]>;
  className?: string;
}) {
  return (
    <code
      className={cn(
        "inline-flex items-center gap-0.5 rounded border border-charcoal-700 bg-charcoal-800 px-1.5 py-0.5 font-mono text-text-dimmed",
        className
      )}
    >
      {accessory.items.map((item, index) => (
        <Fragment key={index}>
          <span
            className={cn(
              "inline-flex items-center",
              index === accessory.items.length - 1 ? "text-sun-100" : "text-text-dimmed"
            )}
          >
            {item.text}
          </span>
          {index < accessory.items.length - 1 && (
            <span className="text-text-dimmed">
              <ChevronRightIcon className="h-4 w-4" />
            </span>
          )}
        </Fragment>
      ))}
    </code>
  );
}

function eventTextClassName(event: SpanTitleProps) {
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
    case "primary": {
      return "text-blue-500";
    }
    default: {
      return "text-text-dimmed";
    }
  }
}
