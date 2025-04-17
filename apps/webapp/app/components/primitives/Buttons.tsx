import { Link, type LinkProps, NavLink, type NavLinkProps } from "@remix-run/react";
import React, { forwardRef, type ReactNode, useImperativeHandle, useRef } from "react";
import { type ShortcutDefinition, useShortcutKeys } from "~/hooks/useShortcutKeys";
import { cn } from "~/utils/cn";
import { ShortcutKey } from "./ShortcutKey";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./Tooltip";
import { Icon, type RenderIcon } from "./Icon";

const sizes = {
  small: {
    button: "h-6 px-2.5 text-xs",
    icon: "h-3.5 -mx-1",
    iconSpacing: "gap-x-2.5",
    shortcutVariant: "small" as const,
    shortcut: "-ml-0.5 -mr-1.5 justify-self-center",
  },
  medium: {
    button: "h-8 px-3 text-sm",
    icon: "h-4 -mx-1",
    iconSpacing: "gap-x-2.5",
    shortcutVariant: "medium" as const,
    shortcut: "-ml-0.5 -mr-1.5 rounded justify-self-center",
  },
  large: {
    button: "h-10 px-2 text-base font-medium",
    icon: "h-5",
    iconSpacing: "gap-x-0.5",
    shortcutVariant: "medium" as const,
    shortcut: "ml-1.5 -mr-0.5",
  },
  "extra-large": {
    button: "h-12 px-2 text-base font-medium",
    icon: "h-5",
    iconSpacing: "gap-x-0.5",
    shortcutVariant: "medium" as const,
    shortcut: "ml-1.5 -mr-0.5",
  },
};

type Size = keyof typeof sizes;

const theme = {
  primary: {
    textColor:
      "text-text-bright group-hover/button:text-white transition group-disabled/button:text-text-dimmed",
    button:
      "bg-indigo-600 border border-indigo-500 group-hover/button:bg-indigo-500 group-hover/button:border-indigo-400 group-disabled/button:opacity-50 group-disabled/button:bg-indigo-600 group-disabled/button:border-indigo-500 group-disabled/button:pointer-events-none",
    shortcut:
      "border-text-bright/40 text-text-bright group-hover/button:border-text-bright/60 group-hover/button:text-text-bright",
    icon: "text-text-bright",
  },
  secondary: {
    textColor: "text-text-bright transition group-disabled/button:text-text-dimmed/80",
    button:
      "bg-secondary group-hover/button:bg-charcoal-600 group-hover/button:border-charcoal-550 border border-charcoal-600 group-disabled/button:bg-secondary group-disabled/button:opacity-60 group-disabled/button:pointer-events-none",
    shortcut:
      "border-text-dimmed/40 text-text-dimmed group-hover/button:text-text-bright group-hover/button:border-text-dimmed",
    icon: "text-text-bright",
  },
  tertiary: {
    textColor: "text-text-bright transition group-disabled/button:text-text-dimmed/80",
    button:
      "bg-tertiary group-hover/button:bg-charcoal-600 group-disabled/button:bg-tertiary group-disabled/button:opacity-60 group-disabled/button:pointer-events-none",
    shortcut:
      "border-text-dimmed/40 text-text-dimmed group-hover/button:text-text-bright group-hover/button:border-text-dimmed",
    icon: "text-text-bright",
  },
  minimal: {
    textColor: "text-text-dimmed group-disabled/button:text-text-dimmed transition",
    button:
      "bg-transparent group-hover/button:bg-tertiary disabled:opacity-50 group-disabled/button:bg-transparent group-disabled/button:pointer-events-none",
    shortcut:
      "border-dimmed/40 text-text-dimmed group-hover/button:text-text-bright/80 group-hover/button:border-dimmed/60",
    icon: "text-text-dimmed",
  },
  danger: {
    textColor:
      "text-text-bright group-hover/button:text-white transition group-disabled/button:text-text-bright/80",
    button:
      "bg-error group-hover/button:bg-rose-500 disabled:opacity-50 group-disabled/button:bg-error group-disabled/button:pointer-events-none",
    shortcut: "border-text-bright text-text-bright group-hover/button:border-bright/60",
    icon: "text-text-bright",
  },
  docs: {
    textColor: "text-blue-200/70 transition group-disabled/button:text-text-dimmed/80",
    button:
      "bg-charcoal-700 border border-charcoal-600/50 shadow group-hover/button:bg-charcoal-650 group-disabled/button:bg-tertiary group-disabled/button:opacity-60 group-disabled/button:pointer-events-none",
    shortcut:
      "border-text-dimmed/40 text-text-dimmed group-hover/button:text-text-bright group-hover/button:border-text-dimmed",
    icon: "text-blue-500",
  },
};

type Theme = keyof typeof theme;

function createVariant(sizeName: Size, themeName: Theme) {
  return {
    textColor: theme[themeName].textColor,
    button: cn(sizes[sizeName].button, theme[themeName].button),
    icon: cn(sizes[sizeName].icon, theme[themeName].icon),
    iconSpacing: sizes[sizeName].iconSpacing,
    shortcutVariant: sizes[sizeName].shortcutVariant,
    shortcut: cn(sizes[sizeName].shortcut, theme[themeName].shortcut),
  };
}

const variant = {
  "primary/small": createVariant("small", "primary"),
  "primary/medium": createVariant("medium", "primary"),
  "primary/large": createVariant("large", "primary"),
  "primary/extra-large": createVariant("extra-large", "primary"),
  "secondary/small": createVariant("small", "secondary"),
  "secondary/medium": createVariant("medium", "secondary"),
  "secondary/large": createVariant("large", "secondary"),
  "secondary/extra-large": createVariant("extra-large", "secondary"),
  "tertiary/small": createVariant("small", "tertiary"),
  "tertiary/medium": createVariant("medium", "tertiary"),
  "tertiary/large": createVariant("large", "tertiary"),
  "tertiary/extra-large": createVariant("extra-large", "tertiary"),
  "minimal/small": createVariant("small", "minimal"),
  "minimal/medium": createVariant("medium", "minimal"),
  "minimal/large": createVariant("large", "minimal"),
  "minimal/extra-large": createVariant("extra-large", "minimal"),
  "danger/small": createVariant("small", "danger"),
  "danger/medium": createVariant("medium", "danger"),
  "danger/large": createVariant("large", "danger"),
  "danger/extra-large": createVariant("extra-large", "danger"),
  "docs/small": createVariant("small", "docs"),
  "docs/medium": createVariant("medium", "docs"),
  "docs/large": createVariant("large", "docs"),
  "docs/extra-large": createVariant("extra-large", "docs"),
  "menu-item": {
    textColor: "text-text-bright px-1",
    button:
      "h-9 px-[0.475rem] text-sm rounded-sm bg-transparent group-hover/button:bg-charcoal-750",
    icon: "h-5",
    iconSpacing: "gap-x-0.5",
    shortcutVariant: undefined,
    shortcut: undefined,
  },
  "small-menu-item": {
    textColor: "text-text-bright",
    button:
      "h-[1.8rem] px-[0.4rem] text-2sm rounded-sm text-text-dimmed bg-transparent group-hover/button:bg-charcoal-750",
    icon: "h-[1.125rem]",
    iconSpacing: "gap-x-1.5",
    shortcutVariant: undefined,
    shortcut: undefined,
  },
  "small-menu-sub-item": {
    textColor: "text-text-dimmed",
    button:
      "h-[1.8rem] px-[0.5rem] ml-5 text-2sm rounded-sm text-text-dimmed bg-transparent group-hover/button:bg-charcoal-750 focus-custom",
    icon: undefined,
    iconSpacing: undefined,
    shortcutVariant: undefined,
    shortcut: undefined,
  },
};

const allVariants = {
  $all: "font-normal text-center font-sans justify-center items-center shrink-0 transition duration-150 rounded-[3px] select-none group-focus/button:outline-none group-disabled/button:opacity-75 group-disabled/button:pointer-events-none focus-custom",
  variant: variant,
};

export type ButtonContentPropsType = {
  children?: React.ReactNode;
  LeadingIcon?: RenderIcon;
  TrailingIcon?: RenderIcon;
  trailingIconClassName?: string;
  leadingIconClassName?: string;
  fullWidth?: boolean;
  textAlignLeft?: boolean;
  className?: string;
  shortcut?: ShortcutDefinition;
  variant: keyof typeof variant;
  shortcutPosition?: "before-trailing-icon" | "after-trailing-icon";
  tooltip?: ReactNode;
  iconSpacing?: string;
  hideShortcutKey?: boolean;
};

export function ButtonContent(props: ButtonContentPropsType) {
  const {
    children: text,
    LeadingIcon,
    TrailingIcon,
    trailingIconClassName,
    leadingIconClassName,
    shortcut,
    fullWidth,
    textAlignLeft,
    className,
    tooltip,
    iconSpacing,
    hideShortcutKey,
  } = props;
  const variation = allVariants.variant[props.variant];

  const btnClassName = cn(allVariants.$all, variation.button);
  const iconClassName = variation.icon;
  const iconSpacingClassName = variation.iconSpacing;
  const shortcutClassName = variation.shortcut;
  const textColorClassName = variation.textColor;

  const renderShortcutKey = () =>
    shortcut &&
    !hideShortcutKey && (
      <ShortcutKey
        className={cn(shortcutClassName)}
        shortcut={shortcut}
        variant={variation.shortcutVariant ?? "medium"}
      />
    );

  const buttonContent = (
    <div className={cn("flex", fullWidth ? "" : "w-fit text-xxs", btnClassName, className)}>
      <div
        className={cn(
          textAlignLeft ? "text-left" : "justify-center",
          "flex w-full items-center",
          iconSpacingClassName,
          iconSpacing
        )}
      >
        {LeadingIcon && (
          <Icon
            icon={LeadingIcon}
            className={cn(
              iconClassName,
              variation.icon,
              leadingIconClassName,
              "shrink-0 justify-start"
            )}
          />
        )}

        {text &&
          (typeof text === "string" ? (
            <span className={cn("mx-auto grow self-center truncate", textColorClassName)}>
              {text}
            </span>
          ) : (
            <>{text}</>
          ))}

        {shortcut &&
          !tooltip &&
          props.shortcutPosition === "before-trailing-icon" &&
          renderShortcutKey()}

        {TrailingIcon && (
          <Icon
            icon={TrailingIcon}
            className={cn(
              iconClassName,
              variation.icon,
              trailingIconClassName,
              "shrink-0 justify-end"
            )}
          />
        )}

        {shortcut &&
          !tooltip &&
          (!props.shortcutPosition || props.shortcutPosition === "after-trailing-icon") &&
          renderShortcutKey()}
      </div>
    </div>
  );

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{buttonContent}</TooltipTrigger>
          <TooltipContent className="text-dimmed flex items-center gap-3 py-1.5 pl-2.5 pr-3 text-xs">
            {tooltip} {shortcut && renderShortcutKey()}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return buttonContent;
}

type ButtonPropsType = Pick<
  JSX.IntrinsicElements["button"],
  "type" | "disabled" | "onClick" | "name" | "value" | "form" | "autoFocus"
> &
  React.ComponentProps<typeof ButtonContent>;

export const Button = forwardRef<HTMLButtonElement, ButtonPropsType>(
  ({ type, disabled, autoFocus, onClick, ...props }, ref) => {
    const innerRef = useRef<HTMLButtonElement>(null);
    useImperativeHandle(ref, () => innerRef.current as HTMLButtonElement);

    if (props.shortcut) {
      useShortcutKeys({
        shortcut: props.shortcut,
        action: () => {
          if (innerRef.current) {
            innerRef.current.click();
          }
        },
        disabled,
      });
    }

    return (
      <button
        className={cn("group/button outline-none focus-custom", props.fullWidth ? "w-full" : "")}
        type={type}
        disabled={disabled}
        onClick={onClick}
        name={props.name}
        value={props.value}
        ref={innerRef}
        form={props.form}
        autoFocus={autoFocus}
      >
        <ButtonContent {...props} />
      </button>
    );
  }
);

type LinkPropsType = Pick<
  LinkProps,
  "to" | "target" | "onClick" | "onMouseDown" | "onMouseEnter" | "onMouseLeave" | "download"
> & { disabled?: boolean } & React.ComponentProps<typeof ButtonContent>;
export const LinkButton = ({
  to,
  onClick,
  onMouseDown,
  onMouseEnter,
  onMouseLeave,
  download,
  disabled = false,
  ...props
}: LinkPropsType) => {
  const innerRef = useRef<HTMLAnchorElement>(null);
  if (props.shortcut) {
    useShortcutKeys({
      shortcut: props.shortcut,
      action: () => {
        if (innerRef.current) {
          innerRef.current.click();
        }
      },
    });
  }

  if (disabled) {
    return (
      <div
        className={cn(
          "group/button pointer-events-none cursor-default opacity-40 outline-none",
          props.fullWidth ? "w-full" : ""
        )}
      >
        <ButtonContent {...props} />
      </div>
    );
  }

  if (to.toString().startsWith("http") || to.toString().startsWith("/resources")) {
    return (
      <ExtLink
        href={to.toString()}
        ref={innerRef}
        className={cn("group/button focus-custom", props.fullWidth ? "w-full" : "")}
        onClick={onClick}
        onMouseDown={onMouseDown}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        download={download}
      >
        <ButtonContent {...props} />
      </ExtLink>
    );
  } else {
    return (
      <Link
        to={to}
        ref={innerRef}
        className={cn("group/button focus-custom", props.fullWidth ? "w-full" : "")}
        onClick={onClick}
        onMouseDown={onMouseDown}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        download={download}
      >
        <ButtonContent {...props} />
      </Link>
    );
  }
};

type NavLinkPropsType = Pick<NavLinkProps, "to" | "target"> &
  Omit<React.ComponentProps<typeof ButtonContent>, "className"> & {
    className?: (props: { isActive: boolean; isPending: boolean }) => string | undefined;
  };
export const NavLinkButton = ({ to, className, target, ...props }: NavLinkPropsType) => {
  return (
    <NavLink
      to={to}
      className={cn("group/button outline-none", props.fullWidth ? "w-full" : "")}
      target={target}
    >
      {({ isActive, isPending }) => (
        <ButtonContent className={className && className({ isActive, isPending })} {...props} />
      )}
    </NavLink>
  );
};

type ExtLinkProps = JSX.IntrinsicElements["a"] & {
  children: React.ReactNode;
  className?: string;
  href: string;
};

const ExtLink = forwardRef<HTMLAnchorElement, ExtLinkProps>(
  ({ className, href, children, ...props }, ref) => {
    return (
      <a
        className={cn(className)}
        target="_blank"
        rel="noopener noreferrer"
        href={href}
        ref={ref}
        {...props}
      >
        {children}
      </a>
    );
  }
);
