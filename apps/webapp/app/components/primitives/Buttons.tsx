import type { LinkProps } from "@remix-run/react";
import { Link } from "@remix-run/react";
import React from "react";
import { cn } from "~/utils/cn";

const sizes = {
  small: "h-[24px] px-2 text-xs",
  medium: "h-[32px] px-2.5 text-sm",
  large: "h-[40px] px-3 text-base",
};

const themes = {
  primary: "text-slate-200 bg-indigo-500 hover:opacity-90",
  secondary:
    "text-slate-200 bg-gradient-secondary transition duration-500 hover:opacity-90",
  secondaryOutline:
    "text-indigo-400 hover:text-indigo-300 border border-indigo-500  focus:ring-indigo-400 py-1/2 hover:border-indigo-400",
};

const btnVariants = {
  $all: "text-center font-semibold font-sans justify-center items-center shrink-0 transition-all duration-300 leading-tight rounded select-none group-focus:outline-none group-disabled:opacity-75 group-disabled:pointer-events-none",
  size: sizes,
  theme: themes,
};

const iconVariants = {
  size: {
    // extraSmall: "h-3",
    small: "h-4",
    medium: "h-4",
    large: "h-5",
    // extraLarge: "h-6",
  },
  theme: {
    primary: "text-slate-900",
    secondary: "text-slate-200",
    secondaryOutline: "text-indigo-400",
  },
};

type ButtonContentPropsType = {
  text?: string | React.ReactNode;
  LeadingIcon?: React.ComponentType<any>;
  TrailingIcon?: React.ComponentType<any>;
  fullWidth?: boolean;
  className?: string;
  size: keyof typeof sizes;
  theme: keyof typeof themes;
};

function ButtonContent(props: ButtonContentPropsType) {
  const { text, LeadingIcon, TrailingIcon, fullWidth, className } = props;

  // Based on the size prop, we'll use the corresponding variant classnames
  const btnClassName = `${btnVariants.$all} ${btnVariants.size[props.size]} ${
    btnVariants.theme[props.theme]
  }`;
  const iconClassName = `${iconVariants.size[props.size]} ${
    iconVariants.theme[props.theme]
  }`;
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
