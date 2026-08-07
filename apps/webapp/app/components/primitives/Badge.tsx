import * as React from "react";
import { cn } from "~/utils/cn";

const variants = {
  default:
    "grid place-items-center rounded-full px-2 h-5 tracking-wider text-xxs bg-background-hover text-text-bright uppercase whitespace-nowrap",
  "extra-small":
    "grid place-items-center border border-border-bright rounded-sm px-1 h-4 text-xxs bg-background-bright text-blue-500 system:border-transparent system:bg-blue-500/10 system:text-blue-500 whitespace-nowrap",
  small:
    "grid place-items-center border border-border-bright rounded-sm px-1 h-5 text-xs bg-background-bright text-blue-500 system:border-transparent system:bg-blue-500/10 system:text-blue-500 whitespace-nowrap",
  "outline-rounded":
    "grid place-items-center rounded-full px-1 h-4 tracking-wider text-xxs border border-blue-500 text-blue-500 uppercase whitespace-nowrap",
  rounded:
    "grid place-items-center rounded-full px-1.5 h-4 text-xxs border bg-blue-600 text-text-bright system:border-transparent system:text-white uppercase whitespace-nowrap",
};

type BadgeProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: keyof typeof variants;
};

export const Badge = React.forwardRef<HTMLDivElement, BadgeProps>(
  ({ className, variant = "default", children, ...props }, ref) => (
    <div ref={ref} className={cn(variants[variant], className)} {...props}>
      <span>{children}</span>
    </div>
  )
);

Badge.displayName = "Badge";
