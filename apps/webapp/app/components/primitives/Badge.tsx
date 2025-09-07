import * as React from "react";
import { cn } from "~/utils/cn";

const variants = {
  default:
    "grid place-items-center rounded-full px-2 h-5 tracking-wider text-xxs bg-charcoal-750 text-text-bright uppercase whitespace-nowrap",
  "extra-small":
    "grid place-items-center border border-charcoal-650 rounded-sm px-1 h-4 text-xxs bg-background-bright text-blue-500 whitespace-nowrap",
  small:
    "grid place-items-center border border-charcoal-650 rounded-sm px-1 h-5 text-xs bg-background-bright text-blue-500 whitespace-nowrap",
  "outline-rounded":
    "grid place-items-center rounded-full px-1 h-4 tracking-wider text-xxs border border-blue-500 text-blue-500 uppercase whitespace-nowrap",
  rounded:
    "grid place-items-center rounded-full px-1.5 h-4 text-xxs border bg-blue-600 text-text-bright uppercase whitespace-nowrap",
};

type BadgeProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: keyof typeof variants;
};

export function Badge({ className, variant = "default", children, ...props }: BadgeProps) {
  return (
    <div className={cn(variants[variant], className)} {...props}>
      <span>{children}</span>
    </div>
  );
}
