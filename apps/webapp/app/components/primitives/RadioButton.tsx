import * as React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { Circle } from "lucide-react";
import { cn } from "~/utils/cn";
import { Badge } from "./Badge";
import { Paragraph } from "./Paragraph";

const variants = {
  "simple/small": {
    button: "w-fit pr-4 data-[disabled]:opacity-70",
    label: "text-sm text-text-bright mt-0.5 select-none",
    description: "text-text-dimmed",
    inputPosition: "mt-1",
    icon: "w-8 h-8 mb-2",
  },
  simple: {
    button: "w-fit pr-4 data-[disabled]:opacity-70",
    label: "text-text-bright select-none",
    description: "text-text-dimmed",
    inputPosition: "mt-1",
    icon: "w-8 h-8 mb-2",
  },
  "button/small": {
    button:
      "flex items-center w-fit h-8 pl-2 pr-3 rounded-md border hover:data-[state=checked]:border-charcoal-600 border-charcoal-650 hover:border-charcoal-600 transition data-[disabled]:opacity-70 data-[disabled]:hover:bg-transparent hover:data-[state=checked]:bg-white/[4%] data-[state=checked]:bg-white/[4%]",
    label: "text-sm text-text-bright select-none",
    description: "text-text-dimmed",
    inputPosition: "mt-0",
    icon: "w-8 h-8 mb-2",
  },
  button: {
    button:
      "w-fit py-2 pl-3 pr-4 rounded border border-charcoal-600 hover:bg-charcoal-850 hover:border-charcoal-500 transition data-[state=checked]:bg-charcoal-850 data-[disabled]:opacity-70",
    label: "text-text-bright select-none",
    description: "text-text-dimmed",
    inputPosition: "mt-1",
    icon: "w-8 h-8 mb-2",
  },
  description: {
    button:
      "w-full p-2.5 hover:data-[state=checked]:bg-white/[4%] data-[state=checked]:bg-white/[4%] transition data-[disabled]:opacity-70 hover:border-charcoal-600 border-charcoal-650 hover:data-[state=checked]:border-charcoal-600 border rounded-md",
    label: "text-text-bright font-semibold -mt-1 text-left text-sm",
    description: "text-text-dimmed -mt-0 text-left",
    inputPosition: "mt-0",
    icon: "w-8 h-8 mb-2",
  },
  icon: {
    button:
      "w-full p-2.5 pb-4 hover:bg-charcoal-850 transition data-[disabled]:opacity-70 data-[state=checked]:bg-charcoal-850 border-charcoal-600 border rounded-sm",
    label: "text-text-bright font-semibold -mt-1 text-left",
    description: "text-text-dimmed -mt-0 text-left",
    inputPosition: "mt-0",
    icon: "mb-3",
  },
};

type RadioButtonCircleProps = {
  checked: boolean;
  boxClassName?: string;
  outerCircleClassName?: string;
  innerCircleClassName?: string;
};

export function RadioButtonCircle({
  checked,
  boxClassName,
  outerCircleClassName,
  innerCircleClassName,
}: RadioButtonCircleProps) {
  return (
    <div
      className={cn(
        "ring-offset-background aspect-square h-4 w-4 shrink-0 overflow-hidden rounded-full border border-charcoal-600 bg-charcoal-700 focus-custom disabled:cursor-not-allowed disabled:opacity-50",
        boxClassName
      )}
    >
      {checked && (
        <div
          className={cn(
            "flex h-full w-full items-center justify-center border border-indigo-500 bg-indigo-600",
            outerCircleClassName
          )}
        >
          <Circle
            className={cn("size-2 fill-text-bright text-text-bright", innerCircleClassName)}
          />
        </div>
      )}
    </div>
  );
}

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
  label?: React.ReactNode;
  description?: React.ReactNode;
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
          "group flex cursor-pointer items-start gap-x-2 transition focus-custom",
          variation.button,
          className
        )}
        {...props}
      >
        <div
          className={cn(
            "ring-offset-background focus-visible:ring-ring aspect-square h-4 w-4 shrink-0 overflow-hidden rounded-full border border-charcoal-600 focus-custom group-data-[state=checked]:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-50",
            variation.inputPosition
          )}
        >
          <RadioGroupPrimitive.Indicator className="flex h-full w-full items-center justify-center rounded-full bg-indigo-600">
            <Circle className="size-2 fill-text-bright text-text-bright" />
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
