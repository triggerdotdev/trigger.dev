"use client";

import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { cn } from "~/utils/cn";

const variations = {
  large: {
    container: "flex items-center gap-x-2 rounded-md hover:bg-tertiary p-2 transition",
    root: "h-6 w-11",
    thumb: "h-5 w-5 data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0",
    text: "text-sm text-charcoal-400 group-hover:text-charcoal-200 transition",
  },
  small: {
    container:
      "flex items-center gap-x-1.5 rounded hover:bg-tertiary pr-1 py-[0.1rem] pl-1.5 transition",
    root: "h-3 w-6",
    thumb: "h-2.5 w-2.5 data-[state=checked]:translate-x-2.5 data-[state=unchecked]:translate-x-0",
    text: "text-xs text-charcoal-400 group-hover:text-charcoal-200 hover:cursor-pointer transition",
  },
};

type SwitchProps = React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root> & {
  label?: React.ReactNode;
  variant: keyof typeof variations;
};

export const Switch = React.forwardRef<React.ElementRef<typeof SwitchPrimitives.Root>, SwitchProps>(
  ({ className, variant, label, ...props }, ref) => {
    const { container, root, thumb, text } = variations[variant];

    return (
      <SwitchPrimitives.Root className={cn("group", container, className)} {...props} ref={ref}>
        {label ? (
          <label className={cn("whitespace-nowrap", text)}>
            {typeof label === "string" ? <span>{label}</span> : label}
          </label>
        ) : null}
        <div
          className={cn(
            "group-focus-visible:ring-ring group-focus-visible:ring-offset-background peer inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors group-focus-visible:ring-2 group-focus-visible:ring-offset-2 group-disabled:cursor-not-allowed group-disabled:opacity-50 group-data-[state=checked]:bg-secondary group-data-[state=unchecked]:bg-charcoal-700 focus-visible:outline-none",
            root
          )}
        >
          <SwitchPrimitives.Thumb
            className={cn(
              thumb,
              "pointer-events-none block rounded-full bg-charcoal-200 shadow-lg ring-0 transition group-data-[state=checked]:bg-charcoal-700"
            )}
          />
        </div>
      </SwitchPrimitives.Root>
    );
  }
);
