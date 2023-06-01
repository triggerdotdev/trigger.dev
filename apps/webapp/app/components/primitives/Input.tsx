import * as React from "react";
import { cn } from "~/utils/cn";
import type { IconNames } from "./NamedIcon";
import { NamedIcon } from "./NamedIcon";

const variants = {
  large: {
    input:
      "px-3 flex h-10 w-full text-bright rounded-md border border-slate-800 bg-slate-850 text-sm ring-offset-background transition file:border-0 file:bg-transparent file:text-base file:font-medium placeholder:text-muted-foreground hover:border-slate-750 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50",

    iconSize: "h-4 w-4 ml-3",
    iconOffset: "pl-[34px]",
    shortcut:
      "right-2 top-[9px] grid h-fit min-w-[22px] place-content-center rounded-sm border border-dimmed/40 py-[3px] px-[5px] text-[0.6rem] font-normal text-dimmed",
  },
  medium: {
    input:
      "px-3 flex h-8 w-full text-bright rounded border border-slate-800 bg-slate-850 text-sm ring-offset-background transition file:border-0 file:bg-transparent file:text-base file:font-medium placeholder:text-muted-foreground hover:border-slate-750 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50",

    iconSize: "h-4 w-4 ml-2.5",
    iconOffset: "pl-[36px]",
    shortcut:
      "right-2 top-[9px] grid h-fit min-w-[22px] place-content-center rounded-sm border border-dimmed/40 py-[3px] px-[5px] text-[0.6rem] font-normal text-dimmed",
  },
  small: {
    input:
      "px-2 flex h-6 w-full text-bright rounded border border-slate-800 bg-slate-850 text-xs ring-offset-background transition file:border-0 file:bg-transparent file:text-xs file:font-medium placeholder:text-muted-foreground hover:border-slate-750 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50",

    iconSize: "h-3 w-3 ml-1.5",
    iconOffset: "pl-[21px]",
    shortcut:
      "right-1 top-1 grid h-fit min-w-[22px] place-content-center rounded-[2px] border border-dimmed/40 py-px px-[3px] text-[0.5rem] font-normal text-dimmed",
  },
  tertiary: {
    input:
      "px-1 flex h-6 w-full text-bright rounded bg-transparent border border-transparent transition hover:border-slate-800 hover:bg-slate-850 focus:border-slate-800 focus:bg-slate-850 text-xs ring-offset-background transition file:border-0 file:bg-transparent file:text-xs file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50",

    iconSize: "h-3 w-3 ml-1.5",
    iconOffset: "pl-[21px]",
    shortcut:
      "right-1 top-1 grid h-fit min-w-[22px] place-content-center rounded-[2px] border border-dimmed/40 py-px px-[3px] text-[0.5rem] font-normal text-dimmed",
  },
};

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  variant?: keyof typeof variants;
  icon?: IconNames;
  shortcut?: string;
  fullWidth?: boolean;
};

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      type,
      shortcut,
      fullWidth = true,
      variant = "medium",
      icon,
      ...props
    },
    ref
  ) => {
    const inputClassName = variants[variant].input;
    const iconClassName = variants[variant].iconSize;
    const iconOffsetClassName = variants[variant].iconOffset;
    const shortcutClassName = variants[variant].shortcut;
    return (
      <div className={cn("relative", fullWidth ? "w-full" : "max-w-max")}>
        {icon && (
          <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center">
            <NamedIcon
              name={icon}
              className={cn(iconClassName, "text-dimmed")}
            />
          </div>
        )}
        <input
          type={type}
          className={cn(
            inputClassName,
            icon ? iconOffsetClassName : "",
            className
          )}
          ref={ref}
          {...props}
        />
        {shortcut && (
          <div className={cn(shortcutClassName, "absolute")}>{shortcut}</div>
        )}
      </div>
    );
  }
);
Input.displayName = "Input";

export { Input };
