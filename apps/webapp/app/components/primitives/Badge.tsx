import * as React from "react";
import { cn } from "~/utils/cn";

const variants = {
  default:
    "grid place-items-center rounded-full px-2.5 h-6 tracking-wider text-xxs bg-slate-700 text-bright uppercase",
};

type BadgeProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: keyof typeof variants;
};

export function Badge({
  className,
  variant = "default",
  ...props
}: BadgeProps) {
  return <div className={cn(variants[variant], className)} {...props} />;
}
