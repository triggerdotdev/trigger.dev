import { cn } from "~/utils/cn";
import * as React from "react";
import { useRef, useEffect } from "react";
import { Paragraph } from "./Paragraph";

const variants = {
  simple: {
    button: "w-fit pr-4",
    label: "text-bright",
    description: "text-dimmed",
    isChecked: "",
  },
  button: {
    button:
      "w-fit py-2 pl-3 pr-4 rounded border border-slate-800 hover:bg-slate-850 hover:border-slate-750 transition",
    label: "text-bright",
    description: "text-dimmed",
    isChecked: "bg-slate-850 border-slate-750",
  },
  description: {
    button: "w-full py-2 pl-3 pr-4 hover:bg-slate-850 transition",
    label: "text-bright font-mono",
    description: "text-dimmed",
    isChecked: "bg-slate-850",
  },
};

export type CheckboxProps = React.InputHTMLAttributes<HTMLInputElement> & {
  variant?: keyof typeof variants;
  label?: string;
  description?: string;
  value?: string;
};

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ variant = "simple", label, description, value, ...props }) => {
    const buttonClassName = variants[variant].button;
    const labelClassName = variants[variant].label;
    const descriptionClassName = variants[variant].description;
    const inputRef = useRef<HTMLInputElement>(null);
    const divRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      const div = divRef.current;
      const input = inputRef.current;
      const isChecked = variants[variant].isChecked.split(" ");

      const handleClick = () => {
        if (input && div && isChecked) {
          input.checked = !input.checked;
          if (input.checked) {
            div.classList.add(...isChecked);
          } else {
            div.classList.remove(...isChecked);
          }
        }
      };

      if (div) {
        div.addEventListener("click", handleClick);
      }

      return () => {
        if (div) {
          div.removeEventListener("click", handleClick);
        }
      };
    }, [variant]);

    return (
      <div
        className={cn(
          "group flex cursor-pointer items-start gap-x-2 transition",
          buttonClassName
        )}
        ref={divRef}
      >
        <input
          type="checkbox"
          value={value}
          defaultChecked={false}
          className="mt-1 cursor-pointer rounded-sm border border-slate-700 bg-transparent transition checked:!bg-indigo-500 group-hover:bg-slate-900 group-hover:checked:bg-indigo-500 group-focus:ring-1 focus:ring-indigo-500 focus:ring-offset-0 focus:ring-offset-transparent focus-visible:outline-none focus-visible:ring-indigo-500"
          id="checkbox"
          ref={inputRef}
          {...props}
        />
        <div>
          <div className="flex gap-2">
            <label
              htmlFor="checkbox"
              className={cn("cursor-pointer", labelClassName)}
            >
              {label}
            </label>
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
