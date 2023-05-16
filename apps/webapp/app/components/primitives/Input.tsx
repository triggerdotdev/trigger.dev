import * as React from "react";
import { cn } from "~/utils/cn";
import type { IconNames } from "./NamedIcon";
import { NamedIcon } from "./NamedIcon";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  icon?: IconNames;
};

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, icon, ...props }, ref) => {
    return (
      <div className="relative">
        {icon && (
          <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
            <NamedIcon name={icon} className="h-4 w-4 text-dimmed" />
          </div>
        )}
        <input
          type={type}
          className={cn(
            "group flex h-10 w-full rounded-md border border-slate-800 bg-slate-850 px-3 py-2 text-sm ring-offset-background transition file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50",
            icon ? "pl-9" : "",
            className
          )}
          ref={ref}
          {...props}
        />
      </div>
    );
  }
);
Input.displayName = "Input";

export { Input };
