import { Link, LinkProps, NavLink, NavLinkProps } from "@remix-run/react";
import React, { ReactComponentElement, forwardRef, useImperativeHandle, useRef } from "react";
import { ShortcutDefinition, useShortcutKeys } from "~/hooks/useShortcutKeys";
import { cn } from "~/utils/cn";
import { IconNamesOrString, NamedIcon } from "./NamedIcon";
import { ShortcutKey } from "./ShortcutKey";

const variant = {
  "primary/small": {
    textColor: "text-bright group-hover:text-white transition group-disabled:text-bright/80 px-1",
    button:
      "h-6 px-[5px] text-xs bg-indigo-600 group-hover:bg-indigo-500/90 group-disabled:opacity-50 group-disabled:pointer-events-none",
    icon: "h-3.5",
    iconSpacing: "gap-x-0.5",
    shortcutVariant: "small" as const,
    shortcut:
      "ml-1 -mr-0.5 border-bright/40 text-bright group-hover:border-bright/60 justify-self-center",
  },
  "secondary/small": {
    textColor: "text-dimmed group-hover:text-bright transition group-disabled:text-dimmed/80 px-1",
    button:
      "h-6 px-[5px] text-xs bg-slate-800 group-hover:bg-slate-700/70 disabled:opacity-50 group-disabled:pointer-events-none",
    icon: "h-3.5",
    iconSpacing: "gap-x-0.5",
    shortcutVariant: "small" as const,
    shortcut:
      "ml-1 -mr-0.5 border-dimmed/40 text-dimmed group-hover:text-bright/80 group-hover:border-dimmed/60",
  },
  "tertiary/small": {
    textColor: "text-dimmed group-hover:text-bright transition group-disabled:text-dimmed/80 px-1",
    button:
      "h-6 px-[5px] text-xs bg-transparent group-hover:bg-slate-850 disabled:opacity-50 group-disabled:pointer-events-none",
    icon: "h-3.5",
    iconSpacing: "gap-x-0.5",
    shortcutVariant: "small" as const,
    shortcut:
      "ml-1 -mr-0.5 border-dimmed/40 text-dimmed group-hover:text-bright/80 group-hover:border-dimmed/60",
  },
  "danger/small": {
    textColor: "text-bright group-hover:text-white transition group-disabled:text-bright/80 px-1",
    button:
      "h-6 px-[5px] text-xs bg-rose-600 group-hover:bg-rose-500 disabled:opacity-50 group-disabled:pointer-events-none",
    icon: "h-3.5",
    iconSpacing: "gap-x-0.5",
    shortcutVariant: "small" as const,
    shortcut: "ml-1 -mr-0.5 border-bright/40 text-bright group-hover:border-bright/60",
  },
  "primary/medium": {
    textColor: "text-bright group-hover:text-white transition group-disabled:text-bright/80 px-1",
    button: "h-8 px-2 text-sm bg-indigo-600 group-hover:bg-indigo-500/90 disabled:opacity-50",
    icon: "h-4",
    iconSpacing: "gap-x-0.5",
    shortcutVariant: "medium" as const,
    shortcut: "ml-1.5 -mr-0.5 border-bright/40 text-bright group-hover:border-bright/60",
  },
  "secondary/medium": {
    textColor: "text-dimmed group-hover:text-bright transition group-disabled:text-dimmed/80 px-1",
    button: "h-8 px-2 text-sm bg-slate-800 group-hover:bg-slate-700/70 disabled:opacity-50",
    icon: "h-4",
    iconSpacing: "gap-x-0.5",
    shortcutVariant: "medium" as const,
    shortcut:
      "ml-1.5 -mr-0.5 border-dimmed/40 text-dimmed group-hover:border-dimmed group-hover:text-bright",
  },
  "tertiary/medium": {
    textColor: "text-dimmed group-hover:text-bright transition group-disabled:text-dimmed/80 px-1",
    button: "h-8 px-2 text-sm bg-transparent group-hover:bg-slate-850 disabled:opacity-50",
    icon: "h-4",
    iconSpacing: "gap-x-0.5",
    shortcutVariant: "medium" as const,
    shortcut:
      "ml-1.5 -mr-0.5 border-bright/40 text-dimmed group-hover:border-bright/60 group-hover:text-bright",
  },
  "danger/medium": {
    textColor: "text-bright group-hover:text-white transition group-disabled:text-bright/80 px-1",
    button: "h-8 px-2 text-sm bg-rose-600 group-hover:bg-rose-500 disabled:opacity-50",
    icon: "h-4",
    iconSpacing: "gap-x-0.5",
    shortcutVariant: "medium" as const,
    shortcut: "ml-1.5 -mr-0.5 border-bright/40 text-bright group-hover:border-bright/60",
  },
  "primary/large": {
    textColor: "text-bright group-hover:text-white transition group-disabled:text-dimmed/80 px-1",
    button:
      "h-10 px-2 text-sm font-medium bg-indigo-600 group-hover:bg-indigo-500/90 group-disabled:opacity-50",
    icon: "h-5",
    iconSpacing: "gap-x-0.5",
    shortcutVariant: undefined,
    shortcut: undefined,
  },
  "secondary/large": {
    textColor: "text-dimmed px-1",
    button:
      "h-10 px-2 text-sm text-dimmed group-hover:text-bright transition font-medium bg-slate-800 group-hover:bg-slate-700/70 disabled:opacity-50",
    icon: "h-5",
    iconSpacing: "gap-x-0.5",
    shortcutVariant: undefined,
    shortcut: undefined,
  },
  "danger/large": {
    textColor: "text-bright group-hover:text-white transition group-disabled:text-bright/50 px-1",
    button:
      "h-10 px-2 text-md bg-rose-600 group-hover:bg-rose-500 group-disabled:opacity-50 group-disabled:group-hover:bg-rose-600",
    icon: "h-5",
    iconSpacing: "gap-x-0.5",
    shortcutVariant: "medium" as const,
    shortcut: "ml-1.5 -mr-0.5 border-bright/40 text-bright group-hover:border-bright/60",
  },
  "primary/extra-large": {
    textColor: "text-bright group-hover:text-white transition group-disabled:text-dimmed/80",
    button:
      "h-12 px-2 text-md font-medium bg-indigo-600 group-hover:bg-indigo-500/90 disabled:opacity-50",
    icon: "h-5",
    iconSpacing: undefined,
    shortcutVariant: undefined,
    shortcut: undefined,
  },
  "secondary/extra-large": {
    textColor: "text-dimmed",
    button:
      "h-12 px-2 text-md text-dimmed group-hover:text-bright transition font-medium bg-slate-800 group-hover:bg-slate-700/70 disabled:opacity-50",
    icon: "h-5",
    iconSpacing: undefined,
    shortcutVariant: undefined,
    shortcut: undefined,
  },
  "danger/extra-large": {
    textColor: "text-bright group-hover:text-white transition group-disabled:text-bright/50",
    button:
      "h-12 px-2 text-md bg-rose-600 group-hover:bg-rose-500 group-disabled:opacity-50 group-disabled:group-hover:bg-rose-600",
    icon: "h-5",
    iconSpacing: undefined,
    shortcutVariant: "medium" as const,
    shortcut: "ml-1.5 -mr-0.5 border-bright/40 text-bright group-hover:border-bright/60",
  },
  "menu-item": {
    textColor: "text-bright px-1",
    button:
      "h-9 px-[0.475rem] text-sm rounded-sm bg-transparent group-hover:bg-slate-800 transition",
    icon: "h-5",
    iconSpacing: "gap-x-0.5",
    shortcutVariant: undefined,
    shortcut: undefined,
  },
  "small-menu-item": {
    textColor: "text-bright",
    button:
      "h-[1.8rem] px-[0.4rem] text-2sm rounded-sm text-dimmed bg-transparent group-hover:bg-slate-850 transition",
    icon: "h-4",
    iconSpacing: "gap-x-1.5",
    shortcutVariant: undefined,
    shortcut: undefined,
  },
  "small-menu-sub-item": {
    textColor: "text-dimmed",
    button:
      "h-[1.8rem] px-[0.5rem] ml-5 text-2sm rounded-sm text-dimmed bg-transparent group-hover:bg-slate-850 transition",
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

type LinkPropsType = Pick<LinkProps, "to" | "target"> & React.ComponentProps<typeof ButtonContent>;
export const LinkButton = ({ to, ...props }: LinkPropsType) => {
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

  if (to.toString().startsWith("http")) {
    return (
      <ExtLink
        href={to.toString()}
        ref={innerRef}
        className={cn("group outline-none", props.fullWidth ? "w-full" : "")}
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
