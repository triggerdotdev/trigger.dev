import { Badge } from "./Badge";
import * as React from "react";

const variants = {
  small: {
    button: "bg-red-500",

    label: "text-bright",
    description: "text-dimmed",
  },
  medium: {
    button: "bg-blue-500",

    label: "text-bright",
    description: "text-dimmed",
  },
  large: {
    button: "bg-yellow-500",

    label: "text-bright",
    description: "text-dimmed",
  },
};

export type CheckboxProps = React.InputHTMLAttributes<HTMLInputElement> & {
  variant?: keyof typeof variants;
};

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({}, ref) => {
    return (
      <div>
        <input
          type="checkbox"
          name="scopes"
          value="Scopes name"
          id="123"
          defaultChecked={false}
          className=""
          ref={ref}
        />
        <div>
          <div className="flex gap-2">
            <label htmlFor="123">Scopes name</label>
            <Badge
              className="px-1.5 py-0.5 text-xs"
              // style={{ backgroundColor: a.color }}
            >
              Badge
            </Badge>
          </div>
          <p className="text-slate-300">admin:repo_hook, public_repo</p>
        </div>
      </div>
    );
  }
);
