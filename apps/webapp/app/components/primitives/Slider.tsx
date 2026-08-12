import * as RadixSlider from "@radix-ui/react-slider";
import type { ComponentProps } from "react";
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
    // Matches the Switch thumb; the secondary-button hairline+shadow keeps the
    // white dot visible on the light track
    thumb:
      "h-3 w-3 border border-border-bright bg-white shadow-sm dark:border-transparent dark:bg-charcoal-200 dark:shadow-none",
  },
  tertiary: {
    container: "h-6 gap-1 rounded-sm hover:bg-background-raised px-1",
    icons: "h-4 w-4 text-text-bright",
    root: "h-4",
    track: "h-1 bg-grid-bright group-hover:bg-background-dimmed",
    range: "bg-transparent group-hover:bg-secondary",
    thumb:
      "h-3 w-3 border-2 border-text-dimmed bg-grid-bright shadow-[0_1px_3px_4px_rgb(0_0_0/0.2),0_1px_2px_-1px_rgb(0_0_0/0.1)] hover:border-text-dimmed focus:shadow-[0_1px_3px_4px_rgb(0_0_0/0.2),0_1px_2px_-1px_rgb(0_0_0/0.1)]",
  },
};

type VariantName = keyof typeof variants;

export type SliderProps = ComponentProps<typeof RadixSlider.Root> & {
  LeadingIcon?: RenderIcon;
  TrailingIcon?: RenderIcon;
  variant: VariantName;
};

export function Slider({
  variant,
  className,
  LeadingIcon,
  TrailingIcon,
  "aria-label": ariaLabel,
  ...props
}: SliderProps) {
  const variation = variants[variant];
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
      >
        <RadixSlider.Track className={cn("relative grow rounded-full", variation.track)}>
          <RadixSlider.Range className={cn("absolute h-full rounded-full", variation.range)} />
        </RadixSlider.Track>
        {/* The thumb is the role="slider" element, so the label lives here */}
        <RadixSlider.Thumb
          aria-label={ariaLabel}
          className={cn(
            "block cursor-pointer rounded-full transition focus:outline-hidden",
            variation.thumb
          )}
        />
      </RadixSlider.Root>
      {TrailingIcon && <Icon icon={TrailingIcon} className={variation.icons} />}
    </div>
  );
}
