"use client";

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "~/utils/cn";
import { Paragraph } from "./Paragraph";
import { ChevronDownIcon } from "@heroicons/react/24/solid";

const Popover = PopoverPrimitive.Root;

const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none animate-in",
        className
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

function PopoverSectionHeader({ title }: { title: string }) {
  return (
    <Paragraph variant="extra-small/bright/caps" className="bg-slate-900 p-2">
      {title}
    </Paragraph>
  );
}

function PopoverArrowTrigger({
  isOpen,
  children,
  className,
  ...props
}: { isOpen?: boolean } & React.ComponentPropsWithoutRef<
  typeof PopoverTrigger
>) {
  return (
    <PopoverTrigger
      {...props}
      className={cn(
        "flex h-6 items-center gap-1 rounded-md px-2 text-slate-400 hover:bg-slate-850 hover:text-slate-200",
        className
      )}
    >
      <Paragraph variant="extra-small" className="hover:text-slate-200">
        {children}
      </Paragraph>
      <ChevronDownIcon
        className={cn(
          "h-3 w-3 transform transition duration-300 ease-in-out",
          isOpen && "-rotate-180"
        )}
      />
    </PopoverTrigger>
  );
}

export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverSectionHeader,
  PopoverArrowTrigger,
};
