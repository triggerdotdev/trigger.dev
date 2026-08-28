"use client";

import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { cn } from "~/utils/cn";
import { type ShortcutDefinition, useShortcutKeys } from "~/hooks/useShortcutKeys";

/*
  The thumb sits inside the track's 2px transparent border, so an even gap all
  round means thumb height == the content box and a travel of (width - thumb).
  The h-4 w-7.5 track is a 12x26 box, hence a 12px thumb travelling 14px. The
  press squish widens the thumb and takes the same off the travel, +4/-4, so the
  leading edge stays pinned. `small` still has the original uneven gap.
*/
const MEDIUM_THUMB = cn(
  "h-3 w-3 data-[state=checked]:translate-x-3.5 data-[state=unchecked]:translate-x-0",
  "group-active:w-4 group-active:data-[state=checked]:translate-x-2.5"
);

const small = {
  container:
    "flex items-center h-6 gap-x-1.5 rounded hover:bg-tertiary pr-1 py-[0.1rem] pl-1.5 hover:disabled:bg-background-raised transition focus-custom disabled:opacity-50 text-text-dimmed hover:text-text-bright disabled:hover:cursor-not-allowed hover:cursor-pointer disabled:hover:text-rose-500",
  root: "h-3 w-5.5",
  thumb: cn(
    "h-2.5 w-2.5 data-[state=checked]:translate-x-2 data-[state=unchecked]:translate-x-0",
    "group-active:w-3.25 group-active:data-[state=checked]:translate-x-1.25"
  ),
  text: "text-xs text-text-dimmed",
};

const variations = {
  large: {
    container: "flex items-center gap-x-2 rounded-md hover:bg-tertiary p-2 transition focus-custom",
    root: "h-6 w-10.5",
    thumb: cn(
      "h-5 w-5 data-[state=checked]:translate-x-4.5 data-[state=unchecked]:translate-x-0",
      "group-active:w-6.5 group-active:data-[state=checked]:translate-x-3"
    ),
    text: "text-sm text-text-dimmed",
  },
  small,
  "tertiary/small": {
    container: small.container,
    root: cn(
      small.root,
      "group-data-[state=unchecked]:bg-surface-control group-hover:group-data-[state=unchecked]:bg-surface-control-active/50"
    ),
    thumb: small.thumb,
    text: cn(
      small.text,
      "transition group-hover:text-text-bright group-hover:group-disabled:text-text-dimmed"
    ),
  },
  "secondary/small": {
    container: cn(
      small.container,
      "border border-border-bright/50 shadow-xs bg-secondary hover:bg-background-raised"
    ),
    root: cn(
      small.root,
      "group-data-[state=unchecked]:bg-surface-control-hover group-hover:group-data-[state=unchecked]:bg-surface-control-active"
    ),
    thumb: small.thumb,
    text: cn(small.text, "transition text-text-bright group-hover:group-disabled:text-text-dimmed"),
  },
  medium: {
    container:
      "flex items-center gap-x-2 rounded-md hover:bg-tertiary py-1.5 px-2 transition focus-custom",
    root: "h-4 w-7.5",
    thumb: MEDIUM_THUMB,
    text: "text-sm text-text-dimmed",
  },
  /* Medium without the hover box, for rows that carry their own affordance. */
  "minimal/medium": {
    container: "flex items-center gap-x-2 rounded-md focus-custom",
    root: "h-4 w-7.5",
    thumb: MEDIUM_THUMB,
    text: "text-sm text-text-dimmed",
  },
};

type SwitchProps = React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root> & {
  label?: React.ReactNode;
  variant: keyof typeof variations;
  shortcut?: ShortcutDefinition;
  labelPosition?: "left" | "right";
};

export const Switch = React.forwardRef<React.ElementRef<typeof SwitchPrimitives.Root>, SwitchProps>(
  ({ className, variant, label, labelPosition = "left", ...props }, ref) => {
    const innerRef = React.useRef<HTMLButtonElement>(null);
    React.useImperativeHandle(ref, () => innerRef.current as HTMLButtonElement);

    const { container, root, thumb, text } = variations[variant];

    useShortcutKeys({
      shortcut: props.shortcut,
      action: () => {
        if (innerRef.current) {
          innerRef.current.click();
        }
      },
      disabled: props.disabled,
    });

    const labelElement = label ? (
      <label
        className={cn("cursor-pointer whitespace-nowrap group-disabled:cursor-not-allowed", text)}
      >
        {typeof label === "string" ? <span>{label}</span> : label}
      </label>
    ) : null;

    const switchElement = (
      <div
        className={cn(
          // Shares --color-accent-fill with the primary button.
          "inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors group-disabled:cursor-not-allowed group-disabled:opacity-50 group-data-[state=checked]:bg-accent-fill group-data-[state=unchecked]:bg-background-raised group-hover:group-data-[state=unchecked]:bg-surface-control-active/50",
          root
        )}
      >
        <SwitchPrimitives.Thumb
          className={cn(
            thumb,
            /* White in every theme once checked: an off-white thumb was 2.80:1
               against the fill, under the 3:1 a control's parts need. */
            "pointer-events-none block rounded-full bg-white transition-[translate,width,background-color] dark:bg-charcoal-200 dark:group-data-[state=checked]:bg-white"
          )}
        />
      </div>
    );

    return (
      <SwitchPrimitives.Root
        className={cn("group", container, className)}
        {...props}
        ref={innerRef}
      >
        {labelPosition === "left" ? labelElement : null}
        {switchElement}
        {labelPosition === "right" ? labelElement : null}
      </SwitchPrimitives.Root>
    );
  }
);
