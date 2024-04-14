import * as React from "react";
import { cn } from "~/utils/cn";

const variants = {
  small: {
    text: "font-sans text-sm font-normal text-text-bright leading-tight",
  },
  medium: {
    text: "font-sans text-sm text-text-bright leading-tight",
  },
  large: {
    text: "font-sans text-base font-medium text-text-bright leading-tight",
  },
};

type LabelProps = React.AllHTMLAttributes<HTMLLabelElement> & {
  className?: string;
  children: React.ReactNode;
  variant?: keyof typeof variants;
  required?: boolean;
};

export function Label({
  className,
  children,
  variant = "medium",
  required = true,
  ...props
}: LabelProps) {
  const variation = variants[variant];
  return (
    <label className={cn(variation.text, className)} {...props}>
      {children}
      {!required && <span className="text-text-dimmed"> (optional)</span>}
    </label>
  );
}
