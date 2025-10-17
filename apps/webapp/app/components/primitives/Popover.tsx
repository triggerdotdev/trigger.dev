"use client";

import { CheckIcon } from "@heroicons/react/20/solid";
import { EllipsisVerticalIcon } from "@heroicons/react/24/solid";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as React from "react";
import { DropdownIcon } from "~/assets/icons/DropdownIcon";
import { Link } from "@remix-run/react";
import * as useShortcutKeys from "~/hooks/useShortcutKeys";
import { cn } from "~/utils/cn";
import { type ButtonContentPropsType, Button, ButtonContent } from "./Buttons";
import { Paragraph, type ParagraphVariant } from "./Paragraph";
import { ShortcutKey } from "./ShortcutKey";
import { type RenderIcon } from "./Icon";

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
        "z-50 min-w-max rounded border border-charcoal-700 bg-background-bright p-4 shadow-md outline-none animate-in data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
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
  variant = "extra-small",
}: {
  title: string;
  variant?: ParagraphVariant;
}) {
  return (
    <Paragraph variant={variant} className="bg-charcoal-750 px-2.5 py-1.5">
      {title}
    </Paragraph>
  );
}

const PopoverMenuItem = React.forwardRef<
  HTMLButtonElement | HTMLAnchorElement,
  {
    to?: string;
    icon?: RenderIcon;
    title: React.ReactNode;
    isSelected?: boolean;
    variant?: ButtonContentPropsType;
    leadingIconClassName?: string;
    className?: string;
    onClick?: React.MouseEventHandler;
    disabled?: boolean;
  }
>(
  (
    {
      to,
      icon,
      title,
      isSelected,
      variant = { variant: "small-menu-item" },
      leadingIconClassName,
      className,
      onClick,
      disabled,
    },
    ref
  ) => {
    const contentProps = {
      variant: variant.variant,
      LeadingIcon: icon,
      leadingIconClassName,
      fullWidth: true,
      textAlignLeft: true,
      TrailingIcon: isSelected ? CheckIcon : undefined,
      className: cn(
        "group-hover:bg-charcoal-700",
        isSelected ? "bg-charcoal-750 group-hover:bg-charcoal-600/50" : undefined,
        className
      ),
    } as const;

    if (to) {
      return (
        <Link
          to={to}
          ref={ref as React.Ref<HTMLAnchorElement>}
          className={cn("group/button focus-custom", contentProps.fullWidth ? "w-full" : "")}
          onClick={onClick as any}
        >
          <ButtonContent {...contentProps}>{title}</ButtonContent>
        </Link>
      );
    }

    return (
      <button
        type="button"
        ref={ref as React.Ref<HTMLButtonElement>}
        onClick={onClick}
        disabled={disabled}
        className={cn(
          "group/button outline-none focus-custom",
          contentProps.fullWidth ? "w-full" : ""
        )}
      >
        <ButtonContent {...contentProps}>{title}</ButtonContent>
      </button>
    );
  }
);
PopoverMenuItem.displayName = "PopoverMenuItem";

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
        "group flex items-center justify-end gap-1 rounded text-text-dimmed transition focus-custom hover:bg-charcoal-850 hover:text-text-bright",
        className
      )}
    >
      {children}
    </PopoverTrigger>
  );
}

function PopoverSideMenuTrigger({
  isOpen,
  children,
  className,
  shortcut,
  ...props
}: {
  isOpen?: boolean;
  shortcut?: useShortcutKeys.ShortcutDefinition;
} & React.ComponentPropsWithoutRef<typeof PopoverTrigger>) {
  const ref = React.useRef<HTMLButtonElement>(null);
  useShortcutKeys.useShortcutKeys({
    shortcut: shortcut,
    action: (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (ref.current) {
        ref.current.click();
      }
    },
  });

  return (
    <PopoverTrigger
      {...props}
      ref={ref}
      className={cn(
        "flex h-[1.8rem] shrink-0 select-none items-center gap-x-1.5 rounded-sm bg-transparent px-[0.4rem] text-center font-sans text-2sm font-normal text-text-bright transition duration-150 focus-custom hover:bg-charcoal-750",
        shortcut ? "justify-between" : "",
        className
      )}
    >
      {children}
      {shortcut && (
        <ShortcutKey className={cn("size-4 flex-none")} shortcut={shortcut} variant={"small"} />
      )}
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
        "group flex h-6 items-center gap-1 rounded pl-2 pr-1 text-text-dimmed transition focus-custom hover:bg-charcoal-700 hover:text-text-bright",
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
      <DropdownIcon className="size-4 min-w-4 text-text-dimmed transition group-hover:text-text-bright" />
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
        "group flex items-center justify-end gap-1 rounded-[3px] p-0.5 text-text-dimmed transition focus-custom hover:bg-tertiary hover:text-text-bright",
        className
      )}
    >
      <EllipsisVerticalIcon className={cn("size-5 transition group-hover:text-text-bright")} />
    </PopoverTrigger>
  );
}

export {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverCustomTrigger,
  PopoverMenuItem,
  PopoverSectionHeader,
  PopoverSideMenuTrigger,
  PopoverTrigger,
  PopoverVerticalEllipseTrigger,
};
