import * as React from "react";
import { forwardRef, useEffect, useState } from "react";
import { cn } from "~/utils/cn";
import { Badge } from "./Badge";
import { Paragraph } from "./Paragraph";

const variants = {
  "simple/small": {
    button: "w-fit pr-4",
    label: "text-sm text-text-bright mt-0.5 select-none",
    description: "text-text-dimmed",
    inputPosition: "mt-1",
    isChecked: "",
    isDisabled: "opacity-70",
  },
  simple: {
    button: "w-fit pr-4",
    label: "text-text-bright select-none",
    description: "text-text-dimmed",
    inputPosition: "mt-1",
    isChecked: "",
    isDisabled: "opacity-70",
  },
  "button/small": {
    button:
      "flex items-center w-fit h-8 pl-2 pr-3 rounded border border-charcoal-600 hover:bg-hover hover:border-charcoal-500 transition",
    label: "text-sm text-text-bright select-none",
    description: "text-text-dimmed",
    inputPosition: "mt-0",
    isChecked: "bg-hover border-charcoal-750 hover:!bg-hover",
    isDisabled: "opacity-70 hover:bg-transparent",
  },
  button: {
    button:
      "w-fit py-2 pl-3 pr-4 rounded border border-charcoal-600 hover:bg-hover hover:border-charcoal-500 transition",
    label: "text-text-bright select-none",
    description: "text-text-dimmed",
    inputPosition: "mt-1",
    isChecked: "bg-hover border-charcoal-750 hover:!bg-hover",
    isDisabled: "opacity-70 hover:bg-transparent",
  },
  description: {
    button: "w-full py-2 pl-3 pr-4 checked:hover:bg-hover transition",
    label: "text-text-bright font-semibold",
    description: "text-text-dimmed",
    inputPosition: "mt-1",
    isChecked: "bg-hover",
    isDisabled: "opacity-70",
  },
};

export type CheckboxProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "checked" | "onChange"
> & {
  id?: string;
  name?: string;
  value?: string;
  variant?: keyof typeof variants;
  label: React.ReactNode;
  description?: string;
  badges?: string[];
  className?: string;
  labelClassName?: string;
  onChange?: (isChecked: boolean) => void;
};

export const CheckboxWithLabel = React.forwardRef<HTMLInputElement, CheckboxProps>(
  (
    {
      id,
      name,
      value,
      variant = "simple",
      type,
      label,
      description,
      defaultChecked,
      badges,
      disabled,
      className,
      labelClassName: externalLabelClassName,
      ...props
    },
    ref
  ) => {
    const [isChecked, setIsChecked] = useState<boolean>(defaultChecked ?? false);
    const [isDisabled, setIsDisabled] = useState<boolean>(disabled ?? false);

    const buttonClassName = variants[variant].button;
    const labelClassName = variants[variant].label;
    const descriptionClassName = variants[variant].description;
    const isCheckedClassName = variants[variant].isChecked;
    const isDisabledClassName = variants[variant].isDisabled;
    const inputPositionClasses = variants[variant].inputPosition;

    useEffect(() => {
      setIsDisabled(disabled ?? false);
    }, [disabled]);

    useEffect(() => {
      if (props.onChange) {
        props.onChange(isChecked);
      }
    }, [isChecked]);

    useEffect(() => {
      setIsChecked(defaultChecked ?? false);
    }, [defaultChecked]);

    return (
      <div
        className={cn(
          "group flex items-start gap-x-2 transition ",
          props.readOnly || disabled ? "cursor-default" : "cursor-pointer",
          buttonClassName,
          isChecked && isCheckedClassName,
          (isDisabled || props.readOnly) && isDisabledClassName,
          className
        )}
        onClick={(e) => {
          //returning false is not setting the state to false, it stops the event from bubbling up
          if (isDisabled || props.readOnly === true) return false;
          setIsChecked((c) => !c);
        }}
      >
        <input
          {...props}
          name={name}
          type="checkbox"
          value={value}
          checked={isChecked}
          onChange={(e) => {
            //returning false is not setting the state to false, it stops the event from bubbling up
            if (isDisabled || props.readOnly === true) return false;
            setIsChecked(!isChecked);
          }}
          disabled={isDisabled}
          className={cn(
            inputPositionClasses,
            props.readOnly || disabled ? "cursor-default" : "cursor-pointer",
            "read-only:border-charcoal-650 disabled:border-charcoal-650 rounded-sm border border-charcoal-600 bg-transparent transition checked:!bg-indigo-500 read-only:!bg-charcoal-700 group-hover:bg-hover group-hover:checked:bg-indigo-500 group-focus:ring-1 focus:ring-indigo-500 focus:ring-offset-0 focus:ring-offset-transparent focus-visible:outline-none  focus-visible:ring-indigo-500 disabled:!bg-charcoal-700"
          )}
          id={id}
          ref={ref}
        />
        <div>
          <div className="flex items-center gap-x-2">
            <label
              htmlFor={id}
              className={cn(
                props.readOnly || disabled ? "cursor-default" : "cursor-pointer",
                labelClassName,
                externalLabelClassName
              )}
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
            <Paragraph variant="small" className={cn("mt-0.5", descriptionClassName)}>
              {description}
            </Paragraph>
          )}
        </div>
      </div>
    );
  }
);

type SimpleCheckboxProps = Omit<React.ComponentProps<"input">, "type">;

export const Checkbox = forwardRef<HTMLInputElement, SimpleCheckboxProps>(
  ({ className, ...props }: SimpleCheckboxProps, ref) => {
    return (
      <input
        type="checkbox"
        className={cn(
          props.readOnly || props.disabled ? "cursor-default" : "cursor-pointer",
          "read-only:border-charcoal-650 disabled:border-charcoal-650 rounded-sm border border-charcoal-600 bg-transparent transition checked:!bg-indigo-500 read-only:!bg-charcoal-700 group-hover:bg-hover group-hover:checked:bg-indigo-500 group-focus:ring-1 focus:ring-indigo-500 focus:ring-offset-0 focus:ring-offset-transparent focus-visible:outline-none  focus-visible:ring-indigo-500 disabled:!bg-charcoal-700"
        )}
        {...props}
        ref={ref}
      />
    );
  }
);
