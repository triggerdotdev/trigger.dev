"use client";

import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { cn } from "~/utils/cn";
import { type ShortcutDefinition, useShortcutKeys } from "~/hooks/useShortcutKeys";

const small = {
  container:
    "flex items-center h-[1.5rem] gap-x-1.5 rounded hover:bg-tertiary pr-1 py-[0.1rem] pl-1.5 hover:disabled:bg-charcoal-700 transition focus-custom disabled:opacity-50 text-text-dimmed hover:text-text-bright disabled:hover:cursor-not-allowed hover:cursor-pointer disabled:hover:text-rose-500",
  root: "h-3 w-6",
  thumb: "size-2.5 data-[state=checked]:translate-x-2.5 data-[state=unchecked]:translate-x-0",
  text: "text-xs text-text-dimmed",
};

const variations = {
  large: {
    container: "flex items-center gap-x-2 rounded-md hover:bg-tertiary p-2 transition focus-custom",
    root: "h-6 w-11",
    thumb: "size-5 data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0",
    text: "text-sm text-text-dimmed",
  },
  small,
  "tertiary/small": {
    container: small.container,
    root: cn(
      small.root,
      "group-data-[state=unchecked]:bg-charcoal-600 group-data-[state=unchecked]:group-hover:bg-charcoal-500/50"
    ),
    thumb: small.thumb,
    text: cn(
      small.text,
      "transition group-hover:text-text-bright group-disabled:group-hover:text-text-dimmed"
    ),
  },
};

type SwitchProps = React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root> & {
  label?: React.ReactNode;
  variant: keyof typeof variations;
  shortcut?: ShortcutDefinition;
};

export const Switch = React.forwardRef<React.ElementRef<typeof SwitchPrimitives.Root>, SwitchProps>(
  ({ className, variant, label, ...props }, ref) => {
    const innerRef = React.useRef<HTMLButtonElement>(null);
    React.useImperativeHandle(ref, () => innerRef.current as HTMLButtonElement);

    const { container, root, thumb, text } = variations[variant];

    if (props.shortcut) {
      useShortcutKeys({
        shortcut: props.shortcut,
        action: () => {
          if (innerRef.current) {
            innerRef.current.click();
          }
        },
        disabled: props.disabled,
      });
    }

    return (
      <SwitchPrimitives.Root
        className={cn("group", container, className)}
        {...props}
        ref={innerRef}
      >
        {label ? (
          <label
            className={cn(
              "cursor-pointer whitespace-nowrap group-disabled:cursor-not-allowed",
              text
            )}
          >
            {typeof label === "string" ? <span>{label}</span> : label}
          </label>
        ) : null}
        <div
          className={cn(
            "inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors group-disabled:cursor-not-allowed group-disabled:opacity-50 group-data-[state=checked]:bg-blue-500 group-data-[state=unchecked]:bg-charcoal-700 group-data-[state=unchecked]:group-hover:bg-charcoal-500/50",
            root
          )}
        >
          <SwitchPrimitives.Thumb
            className={cn(
              thumb,
              "pointer-events-none block rounded-full bg-charcoal-200 transition group-data-[state=checked]:bg-text-bright"
            )}
          />
        </div>
      </SwitchPrimitives.Root>
    );
  }
);
