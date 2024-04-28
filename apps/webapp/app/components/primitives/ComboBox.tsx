import * as Ariakit from "@ariakit/react";
import { ComponentPropsWithRef, ComponentPropsWithoutRef, ElementRef, forwardRef } from "react";
import { cn } from "~/utils/cn";

const variants = {
  "secondary/small": {
    box: "text-xs h-6 bg-tertiary border border-tertiary group-hover:text-text-bright hover:border-charcoal-600 pr-2 pl-1.5 rounded-sm outline-none focus-visible:outline-none",
  },
  medium: {
    box: "text-sm h-8 bg-tertiary border border-tertiary hover:border-charcoal-600 px-2.5",
  },
  minimal: { box: "text-xs h-6 bg-transparent hover:bg-tertiary pl-1.5 pr-2" },
};

type Variant = keyof typeof variants;

export const ComboboxProvider = Ariakit.ComboboxProvider;

type ComboboxProps = {
  variant?: Variant;
  width?: "content" | "full";
};

export const Combobox = forwardRef<
  ElementRef<typeof Ariakit.Combobox>,
  ComponentPropsWithoutRef<typeof Ariakit.Combobox> & ComboboxProps
>(({ variant = "secondary/small", width = "content", className, ...props }, ref) => {
  const box = variants[variant].box;
  return <Ariakit.Combobox ref={ref} className={cn(box, className)} {...props} />;
});

export const ComboboxGroup = Ariakit.ComboboxGroup;
export const ComboboxItem = Ariakit.ComboboxItem;
export const ComboboxItemCheck = Ariakit.ComboboxItemCheck;
export const ComboboxLabel = Ariakit.ComboboxLabel;
export const ComboboxPopover = Ariakit.ComboboxPopover;
