import * as React from "react";
import { cn } from "~/utils/cn";

const variants = {
  default:
    "inline-flex items-center border rounded-full px-2.5 py-1 text-xxs transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 bg-slate-700 text-slate-200 uppercase",
};

type BadgeProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: keyof typeof variants;
};

function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return <div className={cn(variants[variant], className)} {...props} />;
}

export { Badge };
