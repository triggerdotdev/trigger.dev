"use client";

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "~/utils/cn";
import { Paragraph, ParagraphVariant } from "./Paragraph";
import { ChevronDownIcon, EllipsisVerticalIcon } from "@heroicons/react/24/solid";
import { ButtonContentPropsType, LinkButton } from "./Buttons";

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
      avoidCollisions={true}
      className={cn(
        "z-50 min-w-max rounded-md border border-charcoal-700 bg-background-bright p-4 shadow-md outline-none animate-in data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className
      )}
      style={{
        maxHeight: "var(--radix-popover-content-available-height)",
      }}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

function PopoverSectionHeader({
  title,
  variant = "extra-extra-small/dimmed/caps",
}: {
  title: string;
  variant?: ParagraphVariant;
}) {
  return (
    <Paragraph variant={variant} className="bg-charcoal-900 px-2.5 py-1.5">
      {title}
    </Paragraph>
  );
}

function PopoverMenuItem({
  to,
  icon,
  title,
  isSelected,
  variant = { variant: "small-menu-item" },
  leadingIconClassName,
}: {
  to: string;
  icon: string | React.ComponentType<any>;
  title: React.ReactNode;
  isSelected?: boolean;
  variant?: ButtonContentPropsType;
  leadingIconClassName?: string;
}) {
  return (
    <LinkButton
      to={to}
      variant={variant.variant}
      LeadingIcon={icon}
      leadingIconClassName={leadingIconClassName}
      fullWidth
      textAlignLeft
      TrailingIcon={isSelected ? "check" : undefined}
      className={isSelected ? "bg-charcoal-750 group-hover:bg-charcoal-800" : undefined}
    >
      {title}
    </LinkButton>
  );
}

function PopoverCustomTrigger({
  isOpen,
  children,
  className,
  ...props
}: { isOpen?: boolean } & React.ComponentPropsWithoutRef<typeof PopoverTrigger>) {
  return (
    <PopoverTrigger
      {...props}
      className={cn(
        "group flex items-center justify-end gap-1 rounded text-text-dimmed transition hover:bg-charcoal-850 hover:text-text-bright",
        className
      )}
    >
      {children}
    </PopoverTrigger>
  );
}

function PopoverArrowTrigger({
  isOpen,
  children,
  fullWidth = false,
  overflowHidden = false,
  className,
  ...props
}: {
  isOpen?: boolean;
  fullWidth?: boolean;
  overflowHidden?: boolean;
} & React.ComponentPropsWithoutRef<typeof PopoverTrigger>) {
  return (
    <PopoverTrigger
      {...props}
      className={cn(
        "group flex h-6 items-center gap-1 rounded px-2 text-text-dimmed transition hover:bg-charcoal-700 hover:text-text-bright",
        fullWidth && "w-full justify-between",
        className
      )}
    >
      <Paragraph
        variant="extra-small"
        className={cn(
          "flex transition group-hover:text-text-bright",
          overflowHidden && "overflow-hidden"
        )}
      >
        {children}
      </Paragraph>
      <ChevronDownIcon
        className={cn(
          "h-3 w-3 min-w-[0.75rem] text-charcoal-600 transition group-hover:text-text-bright",
          isOpen && "-rotate-180"
        )}
      />
    </PopoverTrigger>
  );
}

function PopoverVerticalEllipseTrigger({
  isOpen,
  className,
  ...props
}: { isOpen?: boolean } & React.ComponentPropsWithoutRef<typeof PopoverTrigger>) {
  return (
    <PopoverTrigger
      {...props}
      className={cn(
        "group flex items-center justify-end gap-1 rounded px-1.5 py-1.5 text-text-dimmed transition hover:bg-charcoal-750 hover:text-text-bright",
        className
      )}
    >
      <EllipsisVerticalIcon className={cn("h-5 w-5 transition group-hover:text-text-bright")} />
    </PopoverTrigger>
  );
}

export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverSectionHeader,
  PopoverCustomTrigger,
  PopoverArrowTrigger,
  PopoverVerticalEllipseTrigger,
  PopoverMenuItem,
};
