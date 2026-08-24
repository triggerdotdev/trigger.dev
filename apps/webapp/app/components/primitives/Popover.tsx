"use client";

import { CheckIcon } from "@heroicons/react/20/solid";
import { EllipsisHorizontalIcon, EllipsisVerticalIcon } from "@heroicons/react/24/solid";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Link } from "@remix-run/react";
import * as React from "react";
import { DropdownIcon } from "~/assets/icons/DropdownIcon";
import { cn } from "~/utils/cn";
import { ButtonContent, type ButtonContentPropsType } from "./Buttons";
import { type RenderIcon } from "./Icon";
import { Paragraph, type ParagraphVariant } from "./Paragraph";

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
        "z-50 min-w-max rounded border border-grid-bright bg-background-bright p-4 shadow-md outline-hidden animate-in data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
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
    <Paragraph variant={variant} className="bg-background-hover px-2.5 py-1.5">
      {title}
    </Paragraph>
  );
}

/* oxlint-disable react/button-has-type -- The trigger supports form button semantics. */
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
    openInNewTab?: boolean;
    name?: string;
    value?: string;
    type?: React.ComponentProps<"button">["type"];
    danger?: boolean;
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
      openInNewTab = false,
      name,
      value,
      type,
      danger = false,
    },
    ref
  ) => {
    const contentProps = {
      variant: variant.variant,
      LeadingIcon: icon,
      leadingIconClassName: danger
        ? cn(leadingIconClassName, "transition-colors group-hover/button:text-error")
        : leadingIconClassName,
      fullWidth: true,
      textAlignLeft: true,
      TrailingIcon: isSelected ? CheckIcon : undefined,
      className: cn(
        danger
          ? "transition-colors group-hover/button:bg-error/10 group-hover/button:text-error [&_span]:transition-colors group-hover/button:[&_span]:text-error"
          : "group-hover:bg-background-raised",
        isSelected ? "bg-background-hover group-hover:bg-surface-control/50" : undefined,
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
          target={openInNewTab ? "_blank" : undefined}
          rel={openInNewTab ? "noopener noreferrer" : undefined}
        >
          <ButtonContent {...contentProps}>{title}</ButtonContent>
        </Link>
      );
    }

    return (
      <button
        ref={ref as React.Ref<HTMLButtonElement>}
        onClick={onClick}
        disabled={disabled}
        className={cn(
          "group/button outline-hidden focus-custom",
          contentProps.fullWidth ? "w-full" : ""
        )}
        name={name}
        value={value}
        type={type ?? "button"}
      >
        <ButtonContent {...contentProps}>{title}</ButtonContent>
      </button>
    );
  }
);
PopoverMenuItem.displayName = "PopoverMenuItem";
/* oxlint-enable react/button-has-type */

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
        "group flex items-center justify-end gap-1 rounded text-text-dimmed transition focus-custom hover:bg-background-dimmed hover:text-text-bright",
        className
      )}
    >
      {children}
    </PopoverTrigger>
  );
}

const popoverArrowTriggerVariants = {
  minimal: {
    trigger: "text-text-dimmed hover:bg-background-raised hover:text-text-bright",
    text: "group-hover:text-text-bright",
    icon: "text-text-dimmed group-hover:text-text-bright",
  },
  primary: {
    // White ink, not text-bright, which flips dark on the light theme.
    trigger:
      "bg-indigo-600 border border-indigo-500 text-white hover:bg-indigo-500 hover:border-indigo-400 disabled:opacity-50 disabled:pointer-events-none",
    text: "text-white",
    icon: "text-white",
  },
  secondary: {
    trigger:
      "bg-secondary border border-border-bright text-text-bright hover:bg-surface-control hover:border-border-brighter disabled:opacity-60 disabled:pointer-events-none",
    text: "text-text-bright",
    icon: "text-text-bright",
  },
  tertiary: {
    trigger: "bg-tertiary text-text-bright hover:bg-surface-control",
    text: "text-text-bright",
    icon: "text-text-bright",
  },
} as const;

type PopoverArrowTriggerVariant = keyof typeof popoverArrowTriggerVariants;

function PopoverArrowTrigger({
  isOpen,
  children,
  fullWidth = false,
  overflowHidden = false,
  variant = "minimal",
  className,
  ...props
}: {
  isOpen?: boolean;
  fullWidth?: boolean;
  overflowHidden?: boolean;
  variant?: PopoverArrowTriggerVariant;
} & React.ComponentPropsWithoutRef<typeof PopoverTrigger>) {
  const variantStyles = popoverArrowTriggerVariants[variant];

  return (
    <PopoverTrigger
      {...props}
      className={cn(
        "group flex h-6 items-center gap-1 rounded pl-2 pr-1 transition focus-custom",
        variantStyles.trigger,
        fullWidth && "w-full justify-between",
        className
      )}
    >
      <Paragraph
        variant="extra-small"
        className={cn("flex transition", variantStyles.text, overflowHidden && "overflow-hidden")}
      >
        {children}
      </Paragraph>
      <DropdownIcon className={cn("size-4 min-w-4 transition", variantStyles.icon)} />
    </PopoverTrigger>
  );
}

const popoverVerticalEllipseVariants = {
  minimal: {
    trigger: "size-6 rounded-[3px] text-text-dimmed hover:bg-tertiary hover:text-text-bright",
    icon: "size-5",
  },
  secondary: {
    trigger:
      "size-6 rounded border border-border-bright bg-secondary text-text-bright hover:bg-surface-control hover:border-border-brighter",
    icon: "size-4",
  },
  // No box/background — the icon inherits the trigger's text color, so callers
  // can drive brightening from a parent hover (e.g. a section header).
  ghost: {
    trigger: "p-1 text-text-faint hover:text-text-bright",
    icon: "size-4",
  },
} as const;

type PopoverVerticalEllipseVariant = keyof typeof popoverVerticalEllipseVariants;

function PopoverEllipseTrigger({
  isOpen,
  variant = "minimal",
  orientation = "vertical",
  className,
  ...props
}: {
  isOpen?: boolean;
  variant?: PopoverVerticalEllipseVariant;
  orientation?: "vertical" | "horizontal";
} & React.ComponentPropsWithoutRef<typeof PopoverTrigger>) {
  const styles = popoverVerticalEllipseVariants[variant];
  const Icon = orientation === "horizontal" ? EllipsisHorizontalIcon : EllipsisVerticalIcon;
  return (
    <PopoverTrigger
      {...props}
      className={cn(
        "group flex items-center justify-center transition focus-custom",
        styles.trigger,
        className
      )}
    >
      <Icon className={cn(styles.icon, "transition")} />
    </PopoverTrigger>
  );
}

// Back-compat alias: the trigger now supports both orientations.
const PopoverVerticalEllipseTrigger = PopoverEllipseTrigger;

export {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverCustomTrigger,
  PopoverMenuItem,
  PopoverSectionHeader,
  PopoverEllipseTrigger,
  PopoverTrigger,
  PopoverVerticalEllipseTrigger,
};
