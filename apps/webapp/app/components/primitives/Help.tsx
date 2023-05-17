"use client";

import * as React from "react";
import * as HelpPrimitive from "@radix-ui/react-dialog";
import { cn } from "~/utils/cn";
import { XMarkIcon } from "@heroicons/react/24/solid";
import { Header2 } from "./Headers";
import { NamedIcon } from "./NamedIcon";

export const Help = HelpPrimitive.Root;
export const HelpTrigger = HelpPrimitive.Trigger;

type HelpContentProps = React.ComponentPropsWithoutRef<
  typeof HelpPrimitive.Content
> & {
  title: string;
};

export const HelpContent = React.forwardRef<
  React.ElementRef<typeof HelpPrimitive.Content>,
  HelpContentProps
>(({ title, className, children, ...props }, ref) => {
  const contentRef = React.useRef<HTMLDivElement>(null);

  return (
    <HelpPrimitive.Portal
      className={cn(className)}
      {...props}
      container={contentRef.current}
    >
      <HelpPrimitive.Content
        ref={contentRef}
        className={cn("flex flex-col", className)}
        {...props}
      >
        <div className="flex justify-between">
          <div className="flex gap-1">
            <NamedIcon name="lightbulb" className="h-3.5 w-3.5" />
            <Header2>{title}</Header2>
          </div>
          <HelpPrimitive.Close className="flex gap-2">
            <span>Dismiss</span>
            <XMarkIcon className="h-4 w-4 text-slate-400" />
          </HelpPrimitive.Close>
        </div>
        <div className="grow">{children}</div>
      </HelpPrimitive.Content>
    </HelpPrimitive.Portal>
  );
});
