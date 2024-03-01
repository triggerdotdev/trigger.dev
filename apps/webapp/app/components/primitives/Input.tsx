import * as React from "react";
import { useImperativeHandle, useRef } from "react";
import { cn } from "~/utils/cn";
import { Icon, RenderIcon } from "./Icon";

const containerBase =
  "has-[:focus-visible]:outline-none has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-0 has-[:focus]:border-ring has-[:focus]:outline-none has-[:focus]:ring-2 has-[:focus]:ring-ring has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 ring-offset-background transition cursor-text";

const inputBase =
  "h-full w-full text-text-bright bg-transparent file:border-0 file:bg-transparent file:text-base file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed outline-none ring-0 border-none";

const shortcutBase =
  "grid h-fit place-content-center border border-dimmed/40 font-normal text-text-dimmed";

const variants = {
  large: {
    container:
      "px-1 w-full h-10 rounded-[3px] border border-charcoal-800 bg-charcoal-750 hover:border-charcoal-750 hover:bg-charcoal-650",
    input: "px-2 text-sm",
    iconSize: "h-4 w-4 ml-1",
    shortcut: "mr-1 min-w-[22px] rounded-sm py-[3px] px-[5px] text-[0.6rem] select-none",
  },
  medium: {
    container:
      "px-1 h-8 w-full rounded border border-charcoal-800 bg-charcoal-750 hover:border-charcoal-750 hover:bg-charcoal-650",
    input: "px-1.5 rounded text-sm",
    iconSize: "h-4 w-4 ml-0.5",
    shortcut: "min-w-[22px] rounded-sm py-[3px] px-[5px] text-[0.6rem]",
  },
  small: {
    container:
      "px-0.5 h-6 w-full rounded border border-charcoal-800 bg-charcoal-750 hover:border-charcoal-750 hover:bg-charcoal-650",
    input: "px-1 rounded text-xs",
    iconSize: "h-3 w-3 ml-0.5",
    shortcut: "min-w-[22px] rounded-[2px] py-px px-[3px] text-[0.5rem]",
  },
  tertiary: {
    container:
      "px-0.5 h-6 w-full rounded border border-transparent hover:border-charcoal-800 hover:bg-charcoal-750",
    input: "px-1 rounded text-xs",
    iconSize: "h-3 w-3 ml-0.5",
    shortcut: "min-w-[22px] rounded-[2px] py-px px-[3px] text-[0.5rem]",
  },
};

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  variant?: keyof typeof variants;
  icon?: RenderIcon;
  shortcut?: string;
  fullWidth?: boolean;
};

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, shortcut, fullWidth = true, variant = "medium", icon, ...props }, ref) => {
    const innerRef = useRef<HTMLInputElement>(null);
    useImperativeHandle(ref, () => innerRef.current as HTMLInputElement);

    const containerClassName = variants[variant].container;
    const inputClassName = variants[variant].input;
    const iconClassName = variants[variant].iconSize;
    const shortcutClassName = variants[variant].shortcut;

    return (
      <div
        className={cn(
          "flex items-center",
          containerBase,
          containerClassName,
          fullWidth ? "w-full" : "max-w-max"
        )}
        onClick={() => innerRef.current && innerRef.current.focus()}
      >
        {icon && (
          <div className="pointer-events-none flex items-center">
            <Icon icon={icon} className={cn(iconClassName, "text-text-dimmed")} />
          </div>
        )}
        <input
          type={type}
          className={cn("grow", inputBase, inputClassName, className)}
          ref={innerRef}
          {...props}
        />
        {shortcut && <div className={cn(shortcutBase, shortcutClassName)}>{shortcut}</div>}
      </div>
    );
  }
);
Input.displayName = "Input";

export { Input };
