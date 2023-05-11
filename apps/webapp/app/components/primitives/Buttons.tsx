import type { LinkProps } from "@remix-run/react";
import { Link } from "@remix-run/react";
import React from "react";
import { cn } from "~/utils/cn";

const variant = {
  "primary/small": {
    button:
      "h-[24px] px-2 text-xs text-bright bg-indigo-600 hover:bg-indigo-500/90 hover:text-white disabled:opacity-50",
    icon: "h-3.5 text-bright",
    shortcut:
      "text-xxs font-medium py-0.25 rounded-[2px] px-0.5 -mr-0.5 ml-0.5 border border-bright/50 text-bright/80",
  },
  "secondary/small": {
    button:
      "h-[24px] px-2 text-xs text-dimmed bg-slate-800 hover:bg-slate-700/70 hover:text-bright disabled:opacity-50",
    icon: "h-3.5 text-dimmed group-hover:text-bright transition",
    shortcut:
      "text-xxs font-medium py-0.25 rounded-[2px] px-0.5 -mr-0.5 ml-0.5 border border-bright/50 text-bright/80",
  },
  "tertiary/small": {
    button:
      "h-[24px] px-2 text-xs text-dimmed bg-transparent hover:bg-slate-850 hover:text-bright disabled:opacity-50",
    icon: "h-3.5 text-dimmed group-hover:text-bright transition",
    shortcut:
      "text-xxs font-medium py-0.25 rounded-[2px] px-0.5 -mr-0.5 ml-0.5 border border-bright/50 text-bright/80",
  },
  "danger/small": {
    button:
      "h-[24px] px-2 text-xs text-bright bg-rose-600 hover:bg-rose-500 hover:text-white disabled:opacity-50",
    icon: "h-3.5 text-bright",
    shortcut:
      "text-xxs font-medium py-0.25 rounded-[2px] px-0.5 -mr-0.5 ml-0.5 border border-bright/50 text-bright/80",
  },
  "primary/medium": {
    button:
      "h-[32px] px-3 text-sm text-bright bg-indigo-600 hover:bg-indigo-500/90 hover:text-white disabled:opacity-50",
    icon: "h-4 text-bright",
    shortcut:
      "text-xs py-0.5 px-1 rounded-[3px] -mr-1.5 ml-1.5 border border-bright/50 text-bright/80",
  },
  "secondary/medium": {
    button:
      "h-[32px] px-3 text-sm text-dimmed bg-slate-800 hover:bg-slate-700/70 hover:text-bright disabled:opacity-50",
    icon: "h-4 text-bright text-dimmed group-hover:text-bright transition",
    shortcut:
      "text-xs py-0.5 px-1 rounded-[3px] -mr-1.5 ml-1.5 border border-bright/50 text-bright/80",
  },
  "tertiary/medium": {
    button:
      "h-[32px] px-3 text-sm text-dimmed bg-transparent hover:bg-slate-850 hover:text-bright disabled:opacity-50",
    icon: "h-4 text-bright text-dimmed group-hover:text-bright transition",
    shortcut:
      "text-xs py-0.5 px-1 rounded-[3px] -mr-1.5 ml-1.5 border border-bright/50 text-bright/80",
  },
  "danger/medium": {
    button:
      "h-[32px] px-3 text-sm text-bright bg-rose-600 hover:bg-rose-500 hover:text-white disabled:opacity-50",
    icon: "h-4 text-bright",
    shortcut:
      "text-xs py-0.5 px-1 rounded-[3px] -mr-1.5 ml-1.5 border border-bright/50 text-bright/80",
  },
};

const allVariants = {
  $all: "font-normal text-center font-sans justify-center items-center shrink-0 transition duration-150 rounded-[3px] select-none group-focus:outline-none group-disabled:opacity-75 group-disabled:pointer-events-none",
  variant: variant,
};

type ButtonContentPropsType = {
  text?: string | React.ReactNode;
  LeadingIcon?: React.ComponentType<any>;
  TrailingIcon?: React.ComponentType<any>;
  fullWidth?: boolean;
  className?: string;
  shortcut?: string;
  variant: keyof typeof variant;
};

function ButtonContent(props: ButtonContentPropsType) {
  const { text, LeadingIcon, TrailingIcon, shortcut, fullWidth, className } =
    props;

  // Based on the size prop, we'll use the corresponding variant classnames
  const btnClassName = cn(
    allVariants.$all,
    allVariants.variant[props.variant].button
  );
  const iconClassName = allVariants.variant[props.variant].icon;
  const shortcutClassName = allVariants.variant[props.variant].shortcut;
  return (
    <div
      className={cn(
        className,
        fullWidth ? "flex" : "inline-flex",
        btnClassName
      )}
    >
      <div className="flex w-full items-center gap-x-1">
        {LeadingIcon && (
          <LeadingIcon
            className={cn(iconClassName, "shrink-0 justify-start")}
          />
        )}

        {text && <span className="mx-auto self-center truncate">{text}</span>}

        {TrailingIcon && (
          <TrailingIcon className={cn(iconClassName, "shrink-0 justify-end")} />
        )}
        {shortcut && (
          <span className={cn(shortcutClassName, "")}>{shortcut}</span>
        )}
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
