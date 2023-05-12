import type { LinkProps } from "@remix-run/react";
import { Link } from "@remix-run/react";
import React from "react";
import { cn } from "~/utils/cn";
import type { IconNames } from "./NamedIcon";
import { NamedIcon } from "./NamedIcon";

const variant = {
  "primary/small": {
    textColor: "text-bright group-hover:text-white transition",
    button:
      "h-[24px] px-[5px] text-xs bg-indigo-600 hover:bg-indigo-500/90 disabled:opacity-50",
    icon: "h-3.5",
    shortcut:
      "text-xxs font-medium py-0.25 rounded-[2px] px-0.5 ml-1 border border-bright/40 text-bright group-hover:border-bright/60 transition",
  },
  "secondary/small": {
    textColor: "text-dimmed group-hover:text-bright transition",
    button:
      "h-[24px] px-[5px] text-xs bg-slate-800 hover:bg-slate-700/70 disabled:opacity-50",
    icon: "h-3.5",
    shortcut:
      "text-xxs font-medium py-0.25 rounded-[2px] px-0.5 ml-1 border border-dimmed/40 text-dimmed group-hover:border-dimmed group-hover:text-bright transition",
  },
  "tertiary/small": {
    textColor: "text-dimmed group-hover:text-bright transition",
    button:
      "h-[24px] px-[5px] text-xs bg-transparent hover:bg-slate-850 disabled:opacity-50",
    icon: "h-3.5",
    shortcut:
      "text-xxs font-medium py-0.25 rounded-[2px] px-0.5 ml-1 border border-bright/40 text-dimmed group-hover:border-bright/60 group-hover:text-bright transition",
  },
  "danger/small": {
    textColor: "text-bright group-hover:text-white transition",
    button:
      "h-[24px] px-[5px] text-xs bg-rose-600 hover:bg-rose-500 disabled:opacity-50",
    icon: "h-3.5",
    shortcut:
      "text-xxs font-medium py-0.25 rounded-[2px] px-0.5 ml-1 border border-bright/40 text-bright group-hover:border-bright/60 transition",
  },
  "primary/medium": {
    textColor: "text-bright group-hover:text-white transition",
    button:
      "h-[32px] px-2 text-sm bg-indigo-600 hover:bg-indigo-500/90 disabled:opacity-50",
    icon: "h-4",
    shortcut:
      "text-[0.6rem] px-1 rounded-[3px] ml-1.5 -mr-0.5 border border-bright/40 text-bright group-hover:border-bright/60 transition",
  },
  "secondary/medium": {
    textColor: "text-dimmed group-hover:text-bright transition",
    button:
      "h-[32px] px-2 text-sm bg-slate-800 hover:bg-slate-700/70 disabled:opacity-50",
    icon: "h-4",
    shortcut:
      "text-[0.6rem] px-1 rounded-[3px] ml-1.5 -mr-0.5 border border-dimmed/40 text-dimmed group-hover:border-dimmed group-hover:text-bright transition",
  },
  "tertiary/medium": {
    textColor: "text-dimmed group-hover:text-bright transition",
    button:
      "h-[32px] px-2 text-sm bg-transparent hover:bg-slate-850 disabled:opacity-50",
    icon: "h-4",
    shortcut:
      "text-[0.6rem] px-1 rounded-[3px] ml-1.5 -mr-0.5 border border-bright/40 text-dimmed group-hover:border-bright/60 group-hover:text-bright transition",
  },
  "danger/medium": {
    textColor: "text-bright group-hover:text-white transition",
    button:
      "h-[32px] px-2 text-sm bg-rose-600 hover:bg-rose-500 disabled:opacity-50",
    icon: "h-4",
    shortcut:
      "text-[0.6rem] px-1 rounded-[3px] ml-1.5 -mr-0.5 border border-bright/40 text-bright group-hover:border-bright/60 transition",
  },
};

const allVariants = {
  $all: "font-normal text-center font-sans justify-center items-center shrink-0 transition duration-150 rounded-[3px] select-none group-focus:outline-none group-disabled:opacity-75 group-disabled:pointer-events-none",
  variant: variant,
};

type ButtonContentPropsType = {
  children?: React.ReactNode;
  LeadingIcon?: React.ComponentType<any> | IconNames;
  TrailingIcon?: React.ComponentType<any> | IconNames;
  trailingIconClassName?: string;
  leadingIconClassName?: string;
  fullWidth?: boolean;
  className?: string;
  shortcut?: string;
  variant: keyof typeof variant;
};

function ButtonContent(props: ButtonContentPropsType) {
  const {
    children: text,
    LeadingIcon,
    TrailingIcon,
    trailingIconClassName,
    leadingIconClassName,
    shortcut,
    fullWidth,
    className,
  } = props;

  // Based on the size prop, we'll use the corresponding variant classnames
  const btnClassName = cn(
    allVariants.$all,
    allVariants.variant[props.variant].button
  );
  const iconClassName = allVariants.variant[props.variant].icon;
  const shortcutClassName = allVariants.variant[props.variant].shortcut;
  const textColorClassName = allVariants.variant[props.variant].textColor;
  return (
    <div
      className={cn(
        className,
        fullWidth ? "flex" : "inline-flex",
        btnClassName
      )}
    >
      <div className="flex w-full items-center gap-x-0.5">
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
                leadingIconClassName,
                textColorClassName,
                "shrink-0 justify-start"
              )}
            />
          ))}

        {text &&
          (typeof text === "string" ? (
            <span
              className={cn(
                "mx-auto self-center truncate px-1",
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
                trailingIconClassName,
                textColorClassName,
                "shrink-0 justify-end"
              )}
            />
          ))}
        {shortcut && <span className={cn(shortcutClassName)}>{shortcut}</span>}
      </div>
    </div>
  );
}

type ButtonPropsType = Pick<
  JSX.IntrinsicElements["button"],
  "type" | "disabled" | "onClick" | "name" | "value"
> &
  React.ComponentProps<typeof ButtonContent>;
export const Button = ({
  type,
  disabled,
  onClick,
  ...props
}: ButtonPropsType) => {
  return (
    <button
      className={cn("group outline-none", props.fullWidth ? "w-full" : "")}
      type={type}
      disabled={disabled}
      onClick={onClick}
      name={props.name}
      value={props.value}
    >
      <ButtonContent {...props} />
    </button>
  );
};

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
