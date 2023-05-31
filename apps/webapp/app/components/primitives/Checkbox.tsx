import * as React from "react";
import { useEffect, useState } from "react";
import { cn } from "~/utils/cn";
import { Badge } from "./Badge";
import { Paragraph } from "./Paragraph";

const variants = {
  simple: {
    button: "w-fit pr-4",
    label: "text-bright",
    description: "text-dimmed",
    isChecked: "",
    isDisabled: "opacity-70",
  },
  button: {
    button:
      "w-fit py-2 pl-3 pr-4 rounded border border-slate-800 hover:bg-slate-850 hover:border-slate-750 transition",
    label: "text-bright",
    description: "text-dimmed",
    isChecked: "bg-slate-850 border-slate-750 hover:!bg-slate-850",
    isDisabled: "opacity-70 hover:bg-transparent",
  },
  description: {
    button: "w-full py-2 pl-3 pr-4 checked:hover:bg-slate-850 transition",
    label: "text-bright font-mono",
    description: "text-dimmed",
    isChecked: "bg-slate-850",
    isDisabled: "opacity-70",
  },
};

export type CheckboxProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "checked"
> & {
  id: string;
  name?: string;
  value?: string;
  variant?: keyof typeof variants;
  label?: string;
  description?: string;
  badge?: string;
  badges?: string[];
  className?: string;
};

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  (
    {
      id,
      name,
      value,
      variant = "simple",
      label,
      description,
      defaultChecked,
      badge,
      badges,
      disabled,
      className,
      ...props
    },
    ref
  ) => {
    const [isChecked, setIsChecked] = useState<boolean>(
      defaultChecked ?? false
    );
    const [isDisabled, setIsDisabled] = useState<boolean>(disabled ?? false);

    const buttonClassName = variants[variant].button;
    const labelClassName = variants[variant].label;
    const descriptionClassName = variants[variant].description;
    const isCheckedClassName = variants[variant].isChecked;
    const isDisabledClassName = variants[variant].isDisabled;

    useEffect(() => {
      setIsDisabled(disabled ?? false);
    }, [disabled]);

    return (
      <div
        className={cn(
          "group flex cursor-pointer items-start gap-x-2 transition",
          buttonClassName,
          isChecked && isCheckedClassName,
          isDisabled && isDisabledClassName,
          className
        )}
        onClick={() => {
          if (isDisabled) return;
          setIsChecked((c) => !c);
        }}
      >
        <input
          name={name}
          type="checkbox"
          value={value}
          checked={isChecked}
          disabled={isDisabled}
          className="mt-1 cursor-pointer rounded-sm border border-slate-700 bg-transparent transition checked:!bg-indigo-500  group-hover:bg-slate-900 group-hover:checked:bg-indigo-500 group-focus:ring-1 focus:ring-indigo-500 focus:ring-offset-0 focus:ring-offset-transparent focus-visible:outline-none focus-visible:ring-indigo-500 disabled:border-slate-650 disabled:!bg-slate-700"
          id={id}
          ref={ref}
          {...props}
        />
        <div>
          <div className="flex items-center gap-x-2">
            <label
              htmlFor={id}
              className={cn("cursor-pointer", labelClassName)}
              onClick={(e) => e.preventDefault()}
            >
              {label}
            </label>
            {badges && (
              <span className="-mr-2 flex gap-x-1.5">
                {badges.map((badge) => (
                  <Badge key={badge}>{badge}</Badge>
                ))}
              </span>
            )}
          </div>
          {variant === "description" && (
            <Paragraph
              variant="base"
              className={cn("mt-0.5", descriptionClassName)}
            >
              {description}
            </Paragraph>
          )}
        </div>
      </div>
    );
  }
);
