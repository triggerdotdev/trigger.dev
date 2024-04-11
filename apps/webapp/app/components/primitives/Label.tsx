import * as React from "react";
import { cn } from "~/utils/cn";

const labelVariants = {
  small: {
    text: "font-sans text-sm font-normal text-text-bright",
  },
  medium: {
    text: "font-sans text-sm leading-5 text-text-bright",
  },
  large: {
    text: "font-sans text-base leading-6 font-medium text-text-bright",
  },
};

type LabelProps = React.AllHTMLAttributes<HTMLLabelElement> & {
  className?: string;
  children: React.ReactNode;
  variant?: keyof typeof labelVariants;
  required?: boolean;
};

export function Label({
  className,
  children,
  variant = "medium",
  required = true,
  ...props
}: LabelProps) {
  const variation = labelVariants[variant];
  return (
    <label className={cn(variation.text, className)} {...props}>
      {children}
      {!required && <span className="text-text-dimmed"> (optional)</span>}
    </label>
  );
}
