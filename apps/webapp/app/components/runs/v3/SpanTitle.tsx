import { ChevronRightIcon } from "@heroicons/react/20/solid";
import { TaskEventStyle } from "@trigger.dev/core/v3";
import type { TaskEventLevel } from "@trigger.dev/database";
import { Fragment } from "react";
import { RunEvent } from "~/presenters/v3/RunPresenter.server";
import { cn } from "~/utils/cn";

type SpanTitleProps = {
  message: string;
  isError: boolean;
  style: TaskEventStyle;
  level: TaskEventLevel;
  isPartial: boolean;
  size: "small" | "large";
};

export function SpanTitle(event: SpanTitleProps) {
  return (
    <span className={cn("flex items-center gap-x-2 overflow-x-hidden", eventTextClassName(event))}>
      <span className="truncate">{event.message}</span>{" "}
      <SpanAccessory accessory={event.style.accessory} size={event.size} />
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
          className={cn("overflow-x-hidden", size === "large" ? "text-sm" : "text-xs")}
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
        "inline-flex items-center gap-0.5 truncate rounded border border-charcoal-700 bg-charcoal-800 px-1.5 py-0.5 font-mono text-text-dimmed",
        className
      )}
    >
      {accessory.items.map((item, index) => (
        <Fragment key={index}>
          <span className={cn("truncate", "text-text-dimmed")}>{item.text}</span>
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

function eventTextClassName(event: Pick<SpanTitleProps, "isError" | "style" | "level">) {
  switch (event.level) {
    case "TRACE": {
      return textClassNameForVariant(event.style.variant);
    }
    case "LOG":
    case "INFO":
    case "DEBUG": {
      return textClassNameForVariant(event.style.variant);
    }
    case "WARN": {
      return "text-amber-400";
    }
    case "ERROR": {
      return "text-error";
    }
    default: {
      return textClassNameForVariant(event.style.variant);
    }
  }
}

export function eventBackgroundClassName(
  event: Pick<RunEvent["data"], "isError" | "style" | "level" | "isPartial" | "isCancelled">
) {
  if (event.isError) {
    return "bg-error";
  }

  if (event.isCancelled) {
    return "bg-charcoal-600";
  }

  switch (event.level) {
    case "TRACE": {
      return backgroundClassNameForVariant(event.style.variant, event.isPartial);
    }
    case "LOG":
    case "INFO":
    case "DEBUG": {
      return backgroundClassNameForVariant(event.style.variant, event.isPartial);
    }
    case "WARN": {
      return "bg-amber-400";
    }
    case "ERROR": {
      return "bg-error";
    }
    default: {
      return backgroundClassNameForVariant(event.style.variant, event.isPartial);
    }
  }
}

function textClassNameForVariant(variant: TaskEventStyle["variant"]) {
  switch (variant) {
    case "primary": {
      return "text-blue-500";
    }
    default: {
      return "text-text-dimmed";
    }
  }
}

function backgroundClassNameForVariant(variant: TaskEventStyle["variant"], isPartial: boolean) {
  switch (variant) {
    case "primary": {
      if (isPartial) {
        return "bg-blue-500";
      }
      return "bg-success";
    }
    default: {
      return "bg-charcoal-500";
    }
  }
}
