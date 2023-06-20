import { Link, LinkProps, NavLink, NavLinkProps } from "@remix-run/react";
import React from "react";
import { ShortcutDefinition } from "~/hooks/useShortcutKeys";
import { cn } from "~/utils/cn";
import { NamedIcon } from "./NamedIcon";
import { ShortcutKey } from "./ShortcutKey";

const variant = {
  "primary/small": {
    textColor:
      "text-bright group-hover:text-white transition group-disabled:text-bright/80",
    button:
      "h-6 px-[5px] text-xs bg-indigo-600 group-hover:bg-indigo-500/90 group-disabled:opacity-50 group-disabled:pointer-events-none",
    icon: "h-3.5",
    shortcutVariant: "small" as const,
    shortcut:
      "ml-1 -mr-0.5 border-bright/40 text-bright group-hover:border-bright/60 justify-self-center",
  },
  "secondary/small": {
    textColor:
      "text-dimmed group-hover:text-bright transition group-disabled:text-dimmed/80",
    button:
      "h-6 px-[5px] text-xs bg-slate-800 group-hover:bg-slate-700/70 disabled:opacity-50 group-disabled:pointer-events-none",
    icon: "h-3.5",
    shortcutVariant: "small" as const,
    shortcut:
      "ml-1 -mr-0.5 border-dimmed/40 text-dimmed group-hover:text-bright/80 group-hover:border-dimmed/60",
  },
  "tertiary/small": {
    textColor:
      "text-dimmed group-hover:text-bright transition group-disabled:text-dimmed/80",
    button:
      "h-6 px-[5px] text-xs bg-transparent group-hover:bg-slate-850 disabled:opacity-50 group-disabled:pointer-events-none",
    icon: "h-3.5",
    shortcutVariant: "small" as const,
    shortcut:
      "ml-1 -mr-0.5 border-dimmed/40 text-dimmed group-hover:text-bright/80 group-hover:border-dimmed/60",
  },
  "danger/small": {
    textColor:
      "text-bright group-hover:text-white transition group-disabled:text-bright/80",
    button:
      "h-6 px-[5px] text-xs bg-rose-600 group-hover:bg-rose-500 disabled:opacity-50 group-disabled:pointer-events-none",
    icon: "h-3.5",
    shortcutVariant: "small" as const,
    shortcut:
      "ml-1 -mr-0.5 border-bright/40 text-bright group-hover:border-bright/60",
  },
  "primary/medium": {
    textColor:
      "text-bright group-hover:text-white transition group-disabled:text-bright/80",
    button:
      "h-8 px-2 text-sm bg-indigo-600 group-hover:bg-indigo-500/90 disabled:opacity-50",
    icon: "h-4",
    shortcutVariant: "medium" as const,
    shortcut:
      "ml-1.5 -mr-0.5 border-bright/40 text-bright group-hover:border-bright/60",
  },
  "secondary/medium": {
    textColor:
      "text-dimmed group-hover:text-bright transition group-disabled:text-dimmed/80",
    button:
      "h-8 px-2 text-sm bg-slate-800 group-hover:bg-slate-700/70 disabled:opacity-50",
    icon: "h-4",
    shortcutVariant: "medium" as const,
    shortcut:
      "ml-1.5 -mr-0.5 border-dimmed/40 text-dimmed group-hover:border-dimmed group-hover:text-bright",
  },
  "tertiary/medium": {
    textColor:
      "text-dimmed group-hover:text-bright transition group-disabled:text-dimmed/80",
    button:
      "h-8 px-2 text-sm bg-transparent group-hover:bg-slate-850 disabled:opacity-50",
    icon: "h-4",
    shortcutVariant: "medium" as const,
    shortcut:
      "ml-1.5 -mr-0.5 border-bright/40 text-dimmed group-hover:border-bright/60 group-hover:text-bright",
  },
  "danger/medium": {
    textColor:
      "text-bright group-hover:text-white transition group-disabled:text-bright/80",
    button:
      "h-8 px-2 text-sm bg-rose-600 group-hover:bg-rose-500 disabled:opacity-50",
    icon: "h-4",
    shortcutVariant: "medium" as const,
    shortcut:
      "ml-1.5 -mr-0.5 border-bright/40 text-bright group-hover:border-bright/60",
  },
  "primary/large": {
    textColor:
      "text-bright group-hover:text-white transition group-disabled:text-dimmed/80",
    button:
      "h-10 px-2 text-sm font-medium bg-indigo-600 group-hover:bg-indigo-500/90 disabled:opacity-50",
    icon: "h-5",
    shortcutVariant: undefined,
    shortcut: undefined,
  },
  "secondary/large": {
    textColor: "text-dimmed",
    button:
      "h-10 px-2 text-sm text-dimmed group-hover:text-bright transition font-medium bg-slate-800 group-hover:bg-slate-700/70 disabled:opacity-50",
    icon: "h-5",
    shortcutVariant: undefined,
    shortcut: undefined,
  },
  "menu-item": {
    textColor: "text-bright",
    button:
      "h-9 px-[0.475rem] text-sm rounded-sm bg-transparent group-hover:bg-slate-800 transition",
    icon: "h-5",
    shortcutVariant: undefined,
    shortcut: undefined,
  },
};

const allVariants = {
  $all: "font-normal text-center font-sans justify-center items-center shrink-0 transition duration-150 rounded-[3px] select-none group-focus:outline-none group-disabled:opacity-75 group-disabled:pointer-events-none",
  variant: variant,
};

type ButtonContentPropsType = {
  children?: React.ReactNode;
  LeadingIcon?: React.ComponentType<any> | string;
  TrailingIcon?: React.ComponentType<any> | string;
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
  const shortcutClassName = variation.shortcut;
  const textColorClassName = variation.textColor;

  return (
    <div
      className={cn(
        fullWidth ? "flex" : "inline-flex text-xxs",
        btnClassName,
        className
      )}
    >
      <div
        className={cn(
          textAlignLeft ? "text-left" : "justify-center",
          "flex w-full items-center gap-x-0.5"
        )}
      >
        {LeadingIcon &&
          (typeof LeadingIcon === "string" ? (
            <NamedIcon
              name={LeadingIcon}
              className={cn(
                iconClassName,
                leadingIconClassName,
                "shrink-0 justify-start"
              )}
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
            <span
              className={cn(
                "mx-auto grow self-center truncate px-1",
                textColorClassName
              )}
            >
              {text}
            </span>
          ) : (
            <>{text}</>
          ))}

        {TrailingIcon &&
          (typeof TrailingIcon === "string" ? (
            <NamedIcon
              name={TrailingIcon}
              className={cn(
                iconClassName,
                trailingIconClassName,
                "shrink-0 justify-end"
              )}
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

export const Button = React.forwardRef<HTMLButtonElement, ButtonPropsType>(
  ({ type, disabled, onClick, ...props }, ref) => {
    return (
      <button
        className={cn("group outline-none", props.fullWidth ? "w-full" : "")}
        type={type}
        disabled={disabled}
        onClick={onClick}
        name={props.name}
        value={props.value}
        ref={ref}
        form={props.form}
      >
        <ButtonContent {...props} />
      </button>
    );
  }
);

type LinkPropsType = Pick<LinkProps, "to" | "target"> &
  React.ComponentProps<typeof ButtonContent>;
export const LinkButton = ({ to, ...props }: LinkPropsType) => {
  if (to.toString().startsWith("http")) {
    return (
      <ExtLink
        href={to.toString()}
        className={cn("group outline-none", props.fullWidth ? "w-full" : "")}
      >
        <ButtonContent {...props} />
      </ExtLink>
    );
  } else {
    return (
      <Link
        to={to}
        className={cn("group outline-none", props.fullWidth ? "w-full" : "")}
      >
        <ButtonContent {...props} />
      </Link>
    );
  }
};

type NavLinkPropsType = Pick<NavLinkProps, "to" | "target"> &
  Omit<React.ComponentProps<typeof ButtonContent>, "className"> & {
    className?: (props: {
      isActive: boolean;
      isPending: boolean;
    }) => string | undefined;
  };
export const NavLinkButton = ({
  to,
  className,
  ...props
}: NavLinkPropsType) => {
  return (
    <NavLink
      to={to}
      className={cn("group outline-none", props.fullWidth ? "w-full" : "")}
    >
      {({ isActive, isPending }) => (
        <ButtonContent
          className={className && className({ isActive, isPending })}
          {...props}
        />
      )}
    </NavLink>
  );
};

type ExtLinkProps = JSX.IntrinsicElements["a"] & {
  children: React.ReactNode;
  className?: string;
  href: string;
};

function ExtLink({ className, href, children, ...props }: ExtLinkProps) {
  return (
    <a
      className={cn(className)}
      target="_blank"
      rel="noopener noreferrer"
      href={href}
      {...props}
    >
      {children}
    </a>
  );
}
