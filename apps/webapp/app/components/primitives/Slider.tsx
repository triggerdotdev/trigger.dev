import * as RadixSlider from "@radix-ui/react-slider";
import { type ComponentProps, useEffect, useState } from "react";
import { cn } from "~/utils/cn";
import type { RenderIcon } from "./Icon";
import { Icon } from "./Icon";
import { SimpleTooltip } from "./Tooltip";

const variants = {
  settings: {
    container: "h-6 gap-1 rounded-sm px-1",
    icons: "h-4 w-4 text-text-bright",
    root: "h-4 grow",
    track: "h-1 bg-grid-bright",
    range: "bg-transparent",
    // #f4f4f6 (white/charcoal-100 midpoint) is opaque on purpose: a half-alpha
    // hover would let the track line show through the handle.
    thumb:
      "h-4.5 w-4.5 border border-border-bright bg-white shadow-sm hover:bg-[#f4f4f6] dark:border-transparent dark:bg-charcoal-300 dark:shadow-none dark:hover:bg-charcoal-200",
    thumbSize: 18,
    mark: "bg-grid-bright border-background-dimmed",
    markHover: "hover:bg-text-dimmed",
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
    mark: "bg-grid-bright border-background-dimmed",
    markHover: "hover:bg-text-dimmed",
  },
};

type VariantName = keyof typeof variants;

export type SliderProps = ComponentProps<typeof RadixSlider.Root> & {
  LeadingIcon?: RenderIcon;
  TrailingIcon?: RenderIcon;
  variant: VariantName;
  /** Label above the thumb while hovered or dragged. Reads `value`, so pass one. */
  valueTooltip?: (value: number) => string;
  /** Values to tick on the track, e.g. the setting's default. */
  marks?: SliderMark[];
};

type SliderMark = {
  value: number;
  /** Tooltip on hover, and the accessible name once `onSelect` is set. */
  label?: string;
  /** Makes the mark a button, e.g. to reset the setting to its default. */
  onSelect?: () => void;
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
  const [isDragging, setIsDragging] = useState(false);

  /* Root's onPointerUp only fires if the release lands back on the slider, so
     watch the window while a drag is in progress. */
  useEffect(() => {
    if (!isDragging) return;
    const stop = () => setIsDragging(false);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [isDragging]);
  const currentValue = props.value?.[0] ?? props.defaultValue?.[0] ?? 0;
  const min = props.min ?? 0;
  const max = props.max ?? 100;

  return (
    <div
      className={cn("group flex items-center", variation.container)}
      // Radix holds pointer capture mid-drag, so this can't fire during one.
      onPointerLeave={() => setIsDragging(false)}
    >
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
          const percent = ((mark.value - min) / (max - min)) * 100;
          if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
          // Same formula as Radix's `getThumbInBoundsOffset`, so the tick lands
          // under the thumb's centre.
          const offset = variation.thumbSize * (0.5 - percent / 100);
          const style = { left: `calc(${percent}% + ${offset}px)` };
          // box-content hangs the borders outside the 2px line, so they read as
          // a gap in the track rather than eating it.
          const markClassName = cn(
            "absolute top-1/2 box-content h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-x-[3px]",
            variation.mark
          );

          if (!mark.onSelect) {
            return <span key={mark.value} aria-hidden className={markClassName} style={style} />;
          }

          return (
            <SimpleTooltip
              key={mark.value}
              asChild
              tabbable
              disableHoverableContent
              side="top"
              sideOffset={6}
              className="px-2 py-1.5 text-xs"
              content={mark.label}
              button={
                <button
                  type="button"
                  aria-label={mark.label}
                  className={cn(markClassName, "cursor-pointer", variation.markHover)}
                  style={style}
                  // Or Radix reads the press as a track click and drags the thumb.
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={mark.onSelect}
                />
              }
            />
          );
        })}
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
                // focus-visible, not focus: a click leaves the thumb focused,
                // which would strand the label on screen.
                isDragging
                  ? "opacity-100"
                  : "opacity-0 group-hover/thumb:opacity-100 group-focus-visible/thumb:opacity-100"
              )}
            >
              {valueTooltip(currentValue)}
              <span className="absolute left-1/2 top-full size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-grid-bright bg-background-bright" />
            </span>
          )}
        </RadixSlider.Thumb>
      </RadixSlider.Root>
      {TrailingIcon && <Icon icon={TrailingIcon} className={variation.icons} />}
    </div>
  );
}
