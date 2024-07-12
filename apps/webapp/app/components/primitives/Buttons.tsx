import { Link, type LinkProps, NavLink, type NavLinkProps } from "@remix-run/react";
import React, { forwardRef, useImperativeHandle, useRef } from "react";
import { type ShortcutDefinition, useShortcutKeys } from "~/hooks/useShortcutKeys";
import { cn } from "~/utils/cn";
import { type IconNamesOrString, NamedIcon } from "./NamedIcon";
import { ShortcutKey } from "./ShortcutKey";

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
      "text-charcoal-900 group-hover:text-charcoal-900 transition group-disabled:text-charcoal-900",
    button:
      "bg-primary group-hover:bg-apple-200 group-disabled:opacity-50 group-disabled:bg-primary group-disabled:pointer-events-none",
    shortcut:
      "border-black/40 text-charcoal-900 group-hover:border-black/60 group-hover:text-charcoal-900",
  },
  secondary: {
    textColor: "text-secondary group-hover:text-secondary transition group-disabled:text-secondary",
    button:
      "bg-transparent border border-secondary group-hover:border-secondary group-hover:bg-secondary/10 group-disabled:opacity-30 group-disabled:border-secondary group-disabled:bg-transparent group-disabled:pointer-events-none",
    shortcut:
      "border-secondary/30 text-secondary group-hover:text-text-bright/80 group-hover:border-dimmed/60",
  },
  tertiary: {
    textColor: "text-text-bright transition group-disabled:text-text-dimmed/80",
    button:
      "bg-tertiary group-hover:bg-charcoal-600 group-disabled:bg-tertiary group-disabled:opacity-60 group-disabled:pointer-events-none",
    shortcut:
      "border-text-dimmed/40 text-text-dimmed group-hover:text-text-bright group-hover:border-text-dimmed",
  },
  minimal: {
    textColor:
      "text-text-dimmed group-hover:text-text-bright transition group-disabled:text-text-dimmed/80",
    button:
      "bg-transparent group-hover:bg-tertiary disabled:opacity-50 group-disabled:bg-transparent group-disabled:pointer-events-none",
    shortcut:
      "border-dimmed/40 text-text-dimmed group-hover:text-text-bright/80 group-hover:border-dimmed/60",
  },
  danger: {
    textColor:
      "text-text-bright group-hover:text-white transition group-disabled:text-text-bright/80",
    button:
      "bg-error group-hover:bg-rose-500 disabled:opacity-50 group-disabled:bg-error group-disabled:pointer-events-none",
    shortcut: "border-text-bright text-text-bright group-hover:border-bright/60",
  },
};

type Theme = keyof typeof theme;

function createVariant(sizeName: Size, themeName: Theme) {
  return {
    textColor: theme[themeName].textColor,
    button: cn(sizes[sizeName].button, theme[themeName].button),
    icon: sizes[sizeName].icon,
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
  "menu-item": {
    textColor: "text-text-bright px-1",
    button:
      "h-9 px-[0.475rem] text-sm rounded-sm bg-transparent group-hover:bg-charcoal-800 transition",
    icon: "h-5",
    iconSpacing: "gap-x-0.5",
    shortcutVariant: undefined,
    shortcut: undefined,
  },
  "small-menu-item": {
    textColor: "text-text-bright",
    button:
      "h-[1.8rem] px-[0.4rem] text-2sm rounded-sm text-text-dimmed bg-transparent group-hover:bg-charcoal-850 transition",
    icon: "h-4",
    iconSpacing: "gap-x-1.5",
    shortcutVariant: undefined,
    shortcut: undefined,
  },
  "small-menu-sub-item": {
    textColor: "text-text-dimmed",
    button:
      "h-[1.8rem] px-[0.5rem] ml-5 text-2sm rounded-sm text-text-dimmed bg-transparent group-hover:bg-charcoal-850 transition",
    icon: undefined,
    iconSpacing: undefined,
    shortcutVariant: undefined,
    shortcut: undefined,
  },
};

const allVariants = {
  $all: "font-normal text-center font-sans justify-center items-center shrink-0 transition duration-150 rounded-[3px] select-none group-focus:outline-none group-disabled:opacity-75 group-disabled:pointer-events-none",
  variant: variant,
};

export type ButtonContentPropsType = {
  children?: React.ReactNode;
  LeadingIcon?: React.ComponentType<any> | IconNamesOrString;
  TrailingIcon?: React.ComponentType<any> | IconNamesOrString;
  trailingIconClassName?: string;
  leadingIconClassName?: string;
  fullWidth?: boolean;
  textAlignLeft?: boolean;
  className?: string;
  shortcut?: ShortcutDefinition;
  variant: keyof typeof variant;
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
  } = props;
  const variation = allVariants.variant[props.variant];

  // Based on the size prop, we'll use the corresponding variant classnames
  const btnClassName = cn(allVariants.$all, variation.button);
  const iconClassName = variation.icon;
  const iconSpacingClassName = variation.iconSpacing;
  const shortcutClassName = variation.shortcut;
  const textColorClassName = variation.textColor;

  return (
    <div className={cn("flex", fullWidth ? "" : "w-fit text-xxs", btnClassName, className)}>
      <div
        className={cn(
          textAlignLeft ? "text-left" : "justify-center",
          "flex w-full items-center",
          iconSpacingClassName
        )}
      >
        {LeadingIcon &&
          (typeof LeadingIcon === "string" ? (
            <NamedIcon
              name={LeadingIcon}
              className={cn(iconClassName, leadingIconClassName, "shrink-0 justify-start")}
            />
          ) : (
            <LeadingIcon
              className={cn(
                iconClassName,
                textColorClassName,
                leadingIconClassName,
                "shrink-0 justify-start"
              )}
            />
          ))}

        {text &&
          (typeof text === "string" ? (
            <span className={cn("mx-auto grow self-center truncate", textColorClassName)}>
              {text}
            </span>
          ) : (
            <>{text}</>
          ))}

        {TrailingIcon &&
          (typeof TrailingIcon === "string" ? (
            <NamedIcon
              name={TrailingIcon}
              className={cn(iconClassName, trailingIconClassName, "shrink-0 justify-end")}
            />
          ) : (
            <TrailingIcon
              className={cn(
                iconClassName,
                textColorClassName,
                trailingIconClassName,
                "shrink-0 justify-end"
              )}
            />
          ))}
        {shortcut && (
          <ShortcutKey
            className={cn(shortcutClassName)}
            shortcut={shortcut}
            variant={variation.shortcutVariant ?? "medium"}
          />
        )}
      </div>
    </div>
  );
}

type ButtonPropsType = Pick<
  JSX.IntrinsicElements["button"],
  "type" | "disabled" | "onClick" | "name" | "value" | "form"
> &
  React.ComponentProps<typeof ButtonContent>;

export const Button = forwardRef<HTMLButtonElement, ButtonPropsType>(
  ({ type, disabled, onClick, ...props }, ref) => {
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
        className={cn("group outline-none", props.fullWidth ? "w-full" : "")}
        type={type}
        disabled={disabled}
        onClick={onClick}
        name={props.name}
        value={props.value}
        ref={innerRef}
        form={props.form}
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
          "group pointer-events-none cursor-default opacity-40 outline-none",
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
        className={cn("group outline-none", props.fullWidth ? "w-full" : "")}
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
        className={cn("group outline-none", props.fullWidth ? "w-full" : "")}
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
      className={cn("group outline-none", props.fullWidth ? "w-full" : "")}
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
