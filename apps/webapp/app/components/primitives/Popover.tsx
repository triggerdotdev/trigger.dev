"use client";

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "~/utils/cn";
import { Paragraph } from "./Paragraph";
import { ChevronDownIcon } from "@heroicons/react/24/solid";
import { LinkButton } from "./Buttons";
import { IconNames } from "./NamedIcon";

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
    <Paragraph
      variant="extra-extra-small/caps"
      className="bg-slate-900 px-2.5 py-2"
    >
      {title}
    </Paragraph>
  );
}

function PopoverMenuItem({
  to,
  icon,
  title,
  isSelected,
}: {
  to: string;
  icon: IconNames;
  title: string;
  isSelected?: boolean;
}) {
  return (
    <LinkButton
      to={to}
      variant="menu-item"
      LeadingIcon={icon}
      fullWidth
      textAlignLeft
      TrailingIcon={isSelected ? "check" : undefined}
      className={
        isSelected ? "bg-slate-750 group-hover:bg-slate-750" : undefined
      }
    >
      {title}
    </LinkButton>
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
        "group flex h-6 items-center gap-1 rounded px-2 text-dimmed transition hover:bg-slate-850",
        className
      )}
    >
      <Paragraph variant="extra-small" className="transition">
        {children}
      </Paragraph>
      <ChevronDownIcon
        className={cn("h-3 w-3 transition", isOpen && "-rotate-180")}
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
  PopoverMenuItem,
};
