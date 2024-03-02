import * as RadixSlider from "@radix-ui/react-slider";
import { ComponentProps } from "react";
import { cn } from "~/utils/cn";

const variants = {
  tertiary: {
    root: "h-4",
    track: "h-1 bg-grid-bright",
    range: "bg-transparent group-hover:bg-secondary",
    thumb:
      "h-3 w-3 border-2 border-text-dimmed bg-grid-bright shadow-[0_1px_3px_4px_rgb(0_0_0_/_0.2),_0_1px_2px_-1px_rgb(0_0_0_/_0.1)] hover:border-text-dimmed focus:shadow-[0_1px_3px_4px_rgb(0_0_0_/_0.2),_0_1px_2px_-1px_rgb(0_0_0_/_0.1)]",
  },
};

type VariantName = keyof typeof variants;

export type SliderProps = ComponentProps<typeof RadixSlider.Root> & { variant: VariantName };

export function Slider({ variant, className, ...props }: SliderProps) {
  const variation = variants[variant];
  return (
    <RadixSlider.Root
      className={cn(
        "group relative flex touch-none select-none items-center",
        variation.root,
        className
      )}
      {...props}
    >
      <RadixSlider.Track className={cn("relative grow rounded-full", variation.track)}>
        <RadixSlider.Range className={cn("absolute h-full rounded-full", variation.range)} />
      </RadixSlider.Track>
      <RadixSlider.Thumb
        className={cn(
          "block cursor-pointer rounded-full transition focus:outline-none",
          variation.thumb
        )}
      />
    </RadixSlider.Root>
  );
}
