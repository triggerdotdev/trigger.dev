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
      "flex items-center w-fit h-8 pl-2 pr-3 rounded border border-border-bright hover:bg-background-dimmed hover:border-border-brightest transition",
    label: "text-sm text-text-bright select-none",
    description: "text-text-dimmed",
    inputPosition: "mt-0",
    isChecked: "bg-background-dimmed border-grid-dimmed hover:bg-background-dimmed!",
    isDisabled: "opacity-70 hover:bg-transparent",
  },
  button: {
    button:
      "w-fit py-2 pl-3 pr-4 rounded border border-border-bright hover:bg-background-dimmed hover:border-border-brightest transition",
    label: "text-text-bright select-none",
    description: "text-text-dimmed",
    inputPosition: "mt-1",
    isChecked: "bg-background-dimmed border-grid-dimmed hover:bg-background-dimmed!",
    isDisabled: "opacity-70 hover:bg-transparent",
  },
  description: {
    button: "w-full py-2 pl-3 pr-4 checked:hover:bg-background-dimmed transition",
    label: "text-text-bright font-semibold",
    description: "text-text-dimmed",
    inputPosition: "mt-1",
    isChecked: "bg-background-dimmed",
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
      onChange,
      ...props
    },
    ref
  ) => {
    const [isChecked, setIsChecked] = useState<boolean>(defaultChecked ?? false);
    const isDisabled = disabled ?? false;
    const onChangeRef = React.useRef(onChange);
    const generatedId = React.useId();
    const inputId = id ?? generatedId;
    const labelId = `${inputId}-label`;
    const descriptionId = `${inputId}-description`;
    const ariaLabelledBy =
      props["aria-label"] || props["aria-labelledby"] ? props["aria-labelledby"] : labelId;

    const buttonClassName = variants[variant].button;
    const labelClassName = variants[variant].label;
    const descriptionClassName = variants[variant].description;
    const isCheckedClassName = variants[variant].isChecked;
    const isDisabledClassName = variants[variant].isDisabled;
    const inputPositionClasses = variants[variant].inputPosition;

    useEffect(() => {
      onChangeRef.current = onChange;
    }, [onChange]);

    useEffect(() => {
      onChangeRef.current?.(isChecked);
    }, [isChecked]);

    useEffect(() => {
      setIsChecked(defaultChecked ?? false);
    }, [defaultChecked]);

    return (
      <label
        className={cn(
          "group flex items-start gap-x-2 transition ",
          props.readOnly || disabled ? "cursor-default" : "cursor-pointer",
          buttonClassName,
          isChecked && isCheckedClassName,
          (isDisabled || props.readOnly) && isDisabledClassName,
          className
        )}
      >
        <input
          {...props}
          name={name}
          type="checkbox"
          value={value}
          checked={isChecked}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={
            props["aria-describedby"] ??
            (variant === "description" && description ? descriptionId : undefined)
          }
          onChange={(e) => {
            if (isDisabled || props.readOnly === true) return;
            setIsChecked(e.target.checked);
          }}
          disabled={isDisabled}
          className={cn(
            inputPositionClasses,
            props.readOnly || disabled ? "cursor-default" : "cursor-pointer",
            // NB: don't use the `read-only:` variant here — checkboxes always
            // match :read-only, so it would override the checked style.
            "rounded-sm border border-border-bright bg-transparent transition checked:bg-indigo-500! group-hover:bg-background-deep checked:group-hover:bg-indigo-500 group-focus:ring-1 focus:ring-indigo-500 focus:ring-offset-0 focus:ring-offset-transparent focus-visible:outline-hidden focus-visible:ring-indigo-500",
            (isDisabled || props.readOnly) &&
              "bg-background-raised! checked:bg-background-raised! checked:group-hover:bg-background-raised! group-hover:bg-background-raised!"
          )}
          id={inputId}
          ref={ref}
        />
        <div>
          <div className="flex items-center gap-x-2">
            <span
              id={labelId}
              className={cn(
                props.readOnly || disabled ? "cursor-default" : "cursor-pointer",
                labelClassName,
                externalLabelClassName
              )}
            >
              {label}
            </span>
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
              id={descriptionId}
              variant="small"
              className={cn("mt-0.5", descriptionClassName)}
            >
              {description}
            </Paragraph>
          )}
        </div>
      </label>
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
          props.disabled
            ? "cursor-not-allowed"
            : props.readOnly
              ? "cursor-default"
              : "cursor-pointer",
          // NB: don't use the `read-only:` variant here — checkboxes always
          // match :read-only, so it would override the checked style.
          "rounded-sm border border-border-bright bg-transparent transition checked:bg-indigo-500! group-hover:bg-background-deep checked:group-hover:bg-indigo-500 group-focus:ring-1 focus:ring-indigo-500 focus:ring-offset-0 focus:ring-offset-transparent focus-visible:outline-hidden focus-visible:ring-indigo-500",
          props.disabled && "opacity-50",
          (props.disabled || props.readOnly) &&
            "bg-background-raised! checked:bg-background-raised! checked:group-hover:bg-background-raised! group-hover:bg-background-raised!",
          className
        )}
        {...props}
        ref={ref}
      />
    );
  }
);
