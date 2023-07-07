import * as React from "react";
import { cn } from "~/utils/cn";

const labelVariants = {
  small: {
    text: "font-sans text-sm font-normal",
  },
  medium: {
    text: "font-sans text-sm leading-5 font-medium",
  },
  large: {
    text: "font-sans text-base leading-6 font-medium",
  },
};

type LabelProps = React.AllHTMLAttributes<HTMLLabelElement> & {
  className?: string;
  children: React.ReactNode;
  variant?: keyof typeof labelVariants;
};

export function Label({
  className,
  children,
  variant = "medium",
  ...props
}: LabelProps) {
  const variation = labelVariants[variant];
  return (
    <label className={cn(variation.text, className)} {...props}>
      {children}
    </label>
  );
}
