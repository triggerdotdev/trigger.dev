"use client";

import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { cn } from "~/utils/cn";
import { type ShortcutDefinition, useShortcutKeys } from "~/hooks/useShortcutKeys";

/*
  The thumb sits inside the track's 2px transparent border, so an even gap on all
  four sides means: thumb height == the track's content box, and a checked travel
  of (content width - thumb). The medium track is h-4 w-7.5, a 12x26 content box,
  so that's a 12px thumb travelling 14px. `large` already follows this; the thumb
  here used to be 14px, which overflowed the 12px content box and left 1px above
  and below against 2px at the ends - a handle tight to the top and bottom rails.

  The press squish widens the thumb and, when checked, pulls the same distance
  off the travel so the leading edge stays pinned: +4px width, -4px translate.

  `small` (h-3 w-5.5, 10px thumb) still has the original mismatch. It's left
  alone here because it's the variant used across the app, not the one on the
  profile page - fixing it would be an 8px thumb travelling 10px.
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
  /* Like medium, minus the hover box: the toggle is the whole target, for rows
     that already carry their own affordance. */
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
          // The checked track shares --color-accent-fill with the primary
          // button, so the two accents are the same purple and can't drift.
          "inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors group-disabled:cursor-not-allowed group-disabled:opacity-50 group-data-[state=checked]:bg-accent-fill group-data-[state=unchecked]:bg-background-raised group-hover:group-data-[state=unchecked]:bg-surface-control-active/50",
          root
        )}
      >
        <SwitchPrimitives.Thumb
          className={cn(
            thumb,
            /* White once checked, in every theme, matching the primary button's
               label on the same fill - an off-white thumb sat at 2.80:1 against
               the track, under the 3:1 a control's parts need. */
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
