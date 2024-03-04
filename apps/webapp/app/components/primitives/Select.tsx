"use client";

import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "~/utils/cn";

const sizes = {
  "secondary/small":
    "text-xs h-6 bg-tertiary hover:bg-tertiary-foreground pr-2 pl-1 bg-charcoal-800",
  medium:
    "text-sm h-8 bg-charcoal-850 border border-charcoal-800 hover:bg-charcoal-800 hover:border-charcoal-750 px-2.5",
};

export type SelectProps = {
  size?: keyof typeof sizes;
  width?: "content" | "full";
};

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;
const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & SelectProps
>(({ className, children, width = "content", size = "secondary/small", ...props }, ref) => {
  const sizeClassName = sizes[size];
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(
        "ring-offset-background focus-visible:bg-tertiary-foreground focus-visible:ring-ring group flex items-center justify-between gap-x-2 rounded text-text-dimmed transition placeholder:text-text-dimmed hover:text-text-bright focus-visible:text-text-bright focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50",
        width === "full" ? "w-full" : "w-min",
        sizeClassName,
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown
          className={cn(
            "h-4 w-4 text-text-dimmed transition group-hover:text-text-bright group-focus:text-text-bright"
          )}
        />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
});
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      className={cn(
        "relative z-50 min-w-max overflow-hidden rounded-md border border-charcoal-700 bg-background-dimmed text-text-bright shadow-md animate-in fade-in-40",
        position === "popper" && "translate-y-1",
        className
      )}
      position={position}
      {...props}
    >
      <SelectPrimitive.Viewport
        className={cn(
          "px-1 py-0",
          position === "popper" &&
            "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]"
        )}
      >
        {children}
      </SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn(
      "-ml-1 -mr-1 mb-1 bg-charcoal-900 py-1.5 pl-2 pr-2 font-sans text-xxs font-normal uppercase leading-normal tracking-wider text-text-dimmed first-of-type:-mt-0",
      className
    )}
    {...props}
  />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative my-0.5 flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-12 text-sm outline-none transition first-of-type:my-1 last-of-type:my-1 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 hover:bg-charcoal-750 focus:bg-charcoal-750/50",
      className
    )}
    {...props}
  >
    <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </SelectPrimitive.ItemIndicator>
    </span>

    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectSeparator = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator
    ref={ref}
    className={cn("bg-muted -mx-1 my-1 h-px", className)}
    {...props}
  />
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
};
