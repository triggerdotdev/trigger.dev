import * as RadixSlider from "@radix-ui/react-slider";
import { type ComponentProps, useState } from "react";
import { cn } from "~/utils/cn";
import type { RenderIcon } from "./Icon";
import { Icon } from "./Icon";

const variants = {
  /* Quiet variant for settings rows: no hover box, no thumb halo */
  settings: {
    container: "h-6 gap-1 rounded-sm px-1",
    icons: "h-4 w-4 text-text-bright",
    root: "h-4 grow",
    track: "h-1 bg-grid-bright",
    range: "bg-transparent",
    // The secondary-button hairline+shadow keeps the white dot visible on the
    // light track
    thumb:
      "h-4.5 w-4.5 border border-border-bright bg-white shadow-sm dark:border-transparent dark:bg-charcoal-200 dark:shadow-none",
    thumbSize: 18,
  },
  tertiary: {
    container: "h-6 gap-1 rounded-sm hover:bg-background-raised px-1",
    icons: "h-4 w-4 text-text-bright",
    root: "h-4",
    track: "h-1 bg-grid-bright group-hover:bg-background-dimmed",
    range: "bg-transparent group-hover:bg-secondary",
    thumb:
      "h-3 w-3 border-2 border-text-dimmed bg-grid-bright shadow-[0_1px_3px_4px_rgb(0_0_0/0.2),0_1px_2px_-1px_rgb(0_0_0/0.1)] hover:border-text-dimmed focus:shadow-[0_1px_3px_4px_rgb(0_0_0/0.2),0_1px_2px_-1px_rgb(0_0_0/0.1)]",
    thumbSize: 12,
  },
};

type VariantName = keyof typeof variants;

export type SliderProps = ComponentProps<typeof RadixSlider.Root> & {
  LeadingIcon?: RenderIcon;
  TrailingIcon?: RenderIcon;
  variant: VariantName;
  /**
   * Opts into a small label above the thumb showing the formatted value, shown
   * while the thumb is hovered or being dragged. It sits inside the thumb, so it
   * tracks the handle exactly. Reads the controlled `value`, so pass one.
   */
  valueTooltip?: (value: number) => string;
  /** Values to tick on the track, e.g. the setting's default. */
  marks?: number[];
};

export function Slider({
  variant,
  className,
  LeadingIcon,
  TrailingIcon,
  "aria-label": ariaLabel,
  valueTooltip,
  marks,
  ...props
}: SliderProps) {
  const variation = variants[variant];
  // The pointer leaves the thumb while dragging, so hover alone can't keep the
  // label up.
  const [isDragging, setIsDragging] = useState(false);
  const currentValue = props.value?.[0] ?? props.defaultValue?.[0] ?? 0;
  const min = props.min ?? 0;
  const max = props.max ?? 100;

  return (
    <div className={cn("group flex items-center", variation.container)}>
      {LeadingIcon && <Icon icon={LeadingIcon} className={variation.icons} />}
      <RadixSlider.Root
        className={cn(
          "relative flex touch-none select-none items-center",
          variation.root,
          className
        )}
        {...props}
        onPointerDown={(event) => {
          props.onPointerDown?.(event);
          setIsDragging(true);
        }}
        onPointerUp={(event) => {
          props.onPointerUp?.(event);
          setIsDragging(false);
        }}
        onPointerCancel={(event) => {
          props.onPointerCancel?.(event);
          setIsDragging(false);
        }}
      >
        <RadixSlider.Track className={cn("relative grow rounded-full", variation.track)}>
          <RadixSlider.Range className={cn("absolute h-full rounded-full", variation.range)} />
        </RadixSlider.Track>
        {marks?.map((mark) => {
          const percent = ((mark - min) / (max - min)) * 100;
          if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
          // Radix keeps the thumb inside the track by offsetting it against its
          // own width, so a plain percentage would sit off the handle. Same
          // formula as its `getThumbInBoundsOffset`, so the tick lands under
          // the thumb's centre.
          const offset = variation.thumbSize * (0.5 - percent / 100);
          return (
            <span
              key={mark}
              aria-hidden
              // box-content keeps the line 1px wide and hangs the background-
              // coloured borders outside it, notching the track either side so
              // the mark reads in both themes.
              className="absolute top-1/2 box-content h-4 w-px -translate-x-1/2 -translate-y-1/2 border-x border-background-bright bg-text-dimmed"
              style={{ left: `calc(${percent}% + ${offset}px)` }}
            />
          );
        })}
        {/* The thumb is the role="slider" element, so the label lives here */}
        <RadixSlider.Thumb
          aria-label={ariaLabel}
          className={cn(
            "group/thumb relative block cursor-pointer rounded-full transition focus:outline-hidden",
            variation.thumb
          )}
        >
          {valueTooltip && (
            <span
              className={cn(
                "pointer-events-none absolute bottom-full left-1/2 mb-2.5 -translate-x-1/2 rounded border border-grid-bright bg-background-bright px-1.5 py-0.5 text-xs tabular-nums text-text-bright shadow-md transition-opacity",
                // Deliberately not keyed off focus: the thumb keeps focus after a
                // click, which would leave the label stuck on.
                isDragging ? "opacity-100" : "opacity-0 group-hover/thumb:opacity-100"
              )}
            >
              {valueTooltip(currentValue)}
              {/* Straddles the bottom edge, hiding the border it overlaps, so the
                  two outer sides read as an arrow pointing at the handle. */}
              <span className="absolute left-1/2 top-full size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-grid-bright bg-background-bright" />
            </span>
          )}
        </RadixSlider.Thumb>
      </RadixSlider.Root>
      {TrailingIcon && <Icon icon={TrailingIcon} className={variation.icons} />}
    </div>
  );
}
