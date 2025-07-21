import * as React from "react";
import { useImperativeHandle, useRef } from "react";
import { cn } from "~/utils/cn";
import { Icon, type RenderIcon } from "./Icon";

const containerBase =
  "has-[:focus-visible]:outline-none has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-charcoal-650 has-[:focus-visible]:ring-offset-0 has-[:focus]:border-ring has-[:focus]:outline-none has-[:focus]:ring-1 has-[:focus]:ring-ring has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 ring-offset-background transition cursor-text";

const inputBase =
  "h-full w-full text-text-bright bg-transparent file:border-0 file:bg-transparent file:text-base file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed outline-none ring-0 border-none";

const variants = {
  large: {
    container:
      "px-1 w-full h-10 rounded-[3px] border border-charcoal-800 bg-charcoal-750 hover:border-charcoal-600 hover:bg-charcoal-650",
    input: "px-2 text-sm",
    iconSize: "size-4 ml-1",
    accessory: "pr-1",
  },
  medium: {
    container:
      "px-1 h-8 w-full rounded border border-charcoal-800 bg-charcoal-750 hover:border-charcoal-600 hover:bg-charcoal-650",
    input: "px-1.5 rounded text-sm",
    iconSize: "size-4 ml-0.5",
    accessory: "pr-1",
  },
  small: {
    container:
      "px-1 h-6 w-full rounded border border-charcoal-800 bg-charcoal-750 hover:border-charcoal-600 hover:bg-charcoal-650",
    input: "px-1 rounded text-xs",
    iconSize: "size-3 ml-0.5",
    accessory: "pr-0.5",
  },
  tertiary: {
    container: "px-1 h-6 w-full rounded hover:bg-charcoal-750",
    input: "px-1 rounded text-xs",
    iconSize: "size-3 ml-0.5",
    accessory: "pr-0.5",
  },
  "secondary-small": {
    container:
      "px-1 h-6 w-full rounded border border-charcoal-600 hover:border-charcoal-550 bg-grid-dimmed hover:bg-charcoal-650",
    input: "px-1 rounded text-xs",
    iconSize: "size-3 ml-0.5",
    accessory: "pr-0.5",
  },
};

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  variant?: keyof typeof variants;
  icon?: RenderIcon;
  accessory?: React.ReactNode;
  fullWidth?: boolean;
  containerClassName?: string;
};

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      type,
      accessory,
      fullWidth = true,
      variant = "medium",
      icon,
      containerClassName,
      ...props
    },
    ref
  ) => {
    const innerRef = useRef<HTMLInputElement>(null);
    useImperativeHandle(ref, () => innerRef.current as HTMLInputElement);

    const variantContainerClassName = variants[variant].container;
    const inputClassName = variants[variant].input;
    const iconClassName = variants[variant].iconSize;

    return (
      <div
        className={cn(
          "flex items-center",
          containerBase,
          variantContainerClassName,
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
        {accessory && <div className={cn(variants[variant].accessory)}>{accessory}</div>}
      </div>
    );
  }
);
Input.displayName = "Input";

export { Input };
