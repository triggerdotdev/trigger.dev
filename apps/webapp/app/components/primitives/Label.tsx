import * as React from "react";
import { cn } from "~/utils/cn";
import { InfoIconTooltip } from "./Tooltip";

// Non-form labels (e.g. settings row titles) share this typography, so it is exported.
export const labelVariants = {
  small: {
    text: "font-sans text-[0.8125rem] font-normal text-text-bright leading-tight flex items-center gap-1",
  },
  medium: {
    text: "font-sans text-sm text-text-bright leading-tight flex items-center gap-1",
  },
  large: {
    text: "font-sans text-base font-medium text-text-bright leading-tight flex items-center gap-1",
  },
};

type LabelProps = React.AllHTMLAttributes<HTMLLabelElement> & {
  className?: string;
  children: React.ReactNode;
  variant?: keyof typeof labelVariants;
  required?: boolean;
  tooltip?: React.ReactNode;
};

export function Label({
  className,
  children,
  variant = "medium",
  required = true,
  tooltip,
  ...props
}: LabelProps) {
  const variation = labelVariants[variant];
  return (
    <label className={cn(variation.text, className)} {...props}>
      {children}
      {tooltip ? <InfoIconTooltip content={tooltip} /> : null}
      {!required && <span className="text-text-dimmed"> (optional)</span>}
    </label>
  );
}
