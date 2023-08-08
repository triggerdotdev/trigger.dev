import * as React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { Circle } from "lucide-react";
import { cn } from "~/utils/cn";
import { Badge } from "./Badge";
import { Paragraph } from "./Paragraph";

const variants = {
  "simple/small": {
    button: "w-fit pr-4 data-[disabled]:opacity-70",
    label: "text-sm text-bright mt-0.5 select-none",
    description: "text-dimmed",
    inputPosition: "mt-1",
    icon: "w-8 h-8 mb-2",
  },
  simple: {
    button: "w-fit pr-4 data-[disabled]:opacity-70",
    label: "text-bright select-none",
    description: "text-dimmed",
    inputPosition: "mt-1",
    icon: "w-8 h-8 mb-2",
  },
  "button/small": {
    button:
      "flex items-center w-fit h-8 pl-2 pr-3 rounded border border-slate-800 hover:bg-slate-850 hover:border-slate-750 transition data-[disabled]:opacity-70 data-[disabled]:hover:bg-transparent data-[state=checked]:bg-slate-850",
    label: "text-sm text-bright select-none",
    description: "text-dimmed",
    inputPosition: "mt-0",
    icon: "w-8 h-8 mb-2",
  },
  button: {
    button:
      "w-fit py-2 pl-3 pr-4 rounded border border-slate-800 hover:bg-slate-850 hover:border-slate-750 transition data-[state=checked]:bg-slate-850 data-[disabled]:opacity-70",
    label: "text-bright select-none",
    description: "text-dimmed",
    inputPosition: "mt-1",
    icon: "w-8 h-8 mb-2",
  },
  description: {
    button:
      "w-full p-2.5 hover:bg-slate-850 transition data-[disabled]:opacity-70 data-[state=checked]:bg-slate-850 border-slate-800 border rounded-sm",
    label: "text-bright font-semibold -mt-1 text-left",
    description: "text-dimmed -mt-0 text-left",
    inputPosition: "mt-0",
    icon: "w-8 h-8 mb-2",
  },
  icon: {
    button:
      "w-full p-2.5 pb-4 hover:bg-slate-850 transition data-[disabled]:opacity-70 data-[state=checked]:bg-slate-850 border-slate-800 border rounded-sm",
    label: "text-bright font-semibold -mt-1 text-left",
    description: "text-dimmed -mt-0 text-left",
    inputPosition: "mt-0",
    icon: "mb-3",
  },
};

export const RadioGroup = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => {
  return <RadioGroupPrimitive.Root className={className} {...props} ref={ref} />;
});

type RadioGroupItemProps = Omit<
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>,
  "onChange"
> & {
  variant?: keyof typeof variants;
  label?: string;
  description?: string;
  badges?: string[];
  className?: string;
  icon?: React.ReactNode;
};

export const RadioGroupItem = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>,
  RadioGroupItemProps
>(
  (
    { className, children, variant = "simple", label, description, badges, icon, ...props },
    ref
  ) => {
    const variation = variants[variant];

    return (
      <RadioGroupPrimitive.Item
        ref={ref}
        className={cn(
          "group flex cursor-pointer items-start gap-x-2 transition",
          variation.button,
          className
        )}
        {...props}
      >
        <div
          className={cn(
            "aspect-square h-4 w-4 shrink-0 overflow-hidden rounded-sm border border-slate-700 ring-offset-background focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
            variation.inputPosition
          )}
        >
          <RadioGroupPrimitive.Indicator className="flex h-full w-full items-center justify-center bg-indigo-700">
            <Circle className="h-1.5 w-1.5 fill-white text-white" />
          </RadioGroupPrimitive.Indicator>
        </div>
        <div className={cn(icon ? "flex h-full flex-col justify-end" : "")}>
          {variant === "icon" && <div className={variation.icon}>{icon}</div>}
          <div className="flex items-center gap-x-2">
            <label htmlFor={props.id} className={cn("cursor-pointer", variation.label)}>
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
          {(variant === "description" || variant === "icon") && (
            <Paragraph variant="small" className={cn("mt-0.5", variation.description)}>
              {description}
            </Paragraph>
          )}
        </div>
      </RadioGroupPrimitive.Item>
    );
  }
);
