import { ChevronRightIcon } from "@heroicons/react/20/solid";
import { TaskEventStyle } from "@trigger.dev/core/v3";
import type { TaskEventLevel } from "@trigger.dev/database";
import { Fragment } from "react";
import { cn } from "~/utils/cn";
import { tablerIcons } from "~/utils/tablerIcons";
import tablerSpritePath from "~/components/primitives/tabler-sprite.svg";

type SpanTitleProps = {
  message: string;
  isError: boolean;
  style: TaskEventStyle;
  level: TaskEventLevel;
  isPartial: boolean;
  size: "small" | "large";
  hideAccessory?: boolean;
  overrideDimmed?: boolean;
};

export function SpanTitle(event: SpanTitleProps) {
  const textClass = eventTextClassName(event);
  const finalTextClass =
    event.overrideDimmed && textClass === "text-text-dimmed" ? "text-text-bright" : textClass;

  return (
    <span className={cn("flex items-center gap-x-2 overflow-x-hidden", finalTextClass)}>
      <span className="truncate">{event.message}</span>{" "}
      {!event.hideAccessory && (
        <SpanAccessory accessory={event.style.accessory} size={event.size} />
      )}
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
    case "pills": {
      return (
        <span className="flex items-center gap-1">
          {accessory.items.map((item, index) => (
            <SpanPill key={index} text={item.text} icon={item.icon} />
          ))}
        </span>
      );
    }
    default: {
      return (
        <span className={cn("flex gap-1")}>
          {accessory.items.map((item, index) => (
            <span key={index} className={cn("inline-flex items-center gap-1")}>
              {item.text}
            </span>
          ))}
        </span>
      );
    }
  }
}

function SpanPill({ text, icon }: { text: string; icon?: string }) {
  const hasIcon = icon && tablerIcons.has(icon);

  return (
    <span className="inline-flex items-center gap-0.5 rounded-full border border-charcoal-700 bg-charcoal-850 px-1.5 py-px text-xxs text-text-dimmed">
      {hasIcon && (
        <svg className="size-3 stroke-[1.5] text-text-dimmed/70">
          <use xlinkHref={`${tablerSpritePath}#${icon}`} />
        </svg>
      )}
      <span className="truncate">{text}</span>
    </span>
  );
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
              <ChevronRightIcon className="size-4" />
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

type RunEvent = {
  isError: boolean;
  style: TaskEventStyle;
  level: TaskEventLevel;
  isPartial: boolean;
  isCancelled: boolean;
};

export function eventBackgroundClassName(event: RunEvent) {
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

export function eventBorderClassName(event: RunEvent) {
  if (event.isError) {
    return "border-error";
  }

  if (event.isCancelled) {
    return "border-charcoal-600";
  }

  switch (event.level) {
    case "TRACE": {
      return borderClassNameForVariant(event.style.variant, event.isPartial);
    }
    case "LOG":
    case "INFO":
    case "DEBUG": {
      return borderClassNameForVariant(event.style.variant, event.isPartial);
    }
    case "WARN": {
      return "border-amber-400";
    }
    case "ERROR": {
      return "border-error";
    }
    default: {
      return borderClassNameForVariant(event.style.variant, event.isPartial);
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

function borderClassNameForVariant(variant: TaskEventStyle["variant"], isPartial: boolean) {
  switch (variant) {
    case "primary": {
      if (isPartial) {
        return "border-blue-500";
      }
      return "border-success";
    }
    default: {
      return "border-charcoal-500";
    }
  }
}
