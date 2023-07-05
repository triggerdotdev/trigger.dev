import { Link } from "@remix-run/react";
import { cn } from "~/utils/cn";
import { IconNamesOrString, NamedIcon } from "./NamedIcon";

const paragraphVariants = {
  base: {
    text: "font-sans text-base font-normal text-dimmed",
    spacing: "mb-3",
  },
  "base/bright": {
    text: "font-sans text-base font-normal text-bright",
    spacing: "mb-3",
  },
  small: {
    text: "font-sans text-sm font-normal text-dimmed",
    spacing: "mb-2",
  },
  "small/bright": {
    text: "font-sans text-sm font-normal text-bright",
    spacing: "mb-2",
  },
  "extra-small": {
    text: "font-sans text-xs font-normal text-dimmed",
    spacing: "mb-1.5",
  },
  "extra-small/bright": {
    text: "font-sans text-xs font-normal text-bright",
    spacing: "mb-1.5",
  },
  "extra-small/mono": {
    text: "font-mono text-xs font-normal text-dimmed",
    spacing: "mb-1.5",
  },
  "extra-small/bright/mono": {
    text: "font-mono text-xs text-bright",
    spacing: "mb-1.5",
  },
  "extra-small/caps": {
    text: "font-sans text-xs uppercase tracking-wider font-normal text-dimmed",
    spacing: "mb-1.5",
  },
  "extra-small/bright/caps": {
    text: "font-sans text-xs uppercase tracking-wider font-normal text-bright",
    spacing: "mb-1.5",
  },
  "extra-extra-small": {
    text: "font-sans text-xxs font-normal text-dimmed",
    spacing: "mb-1",
  },
  "extra-extra-small/bright": {
    text: "font-sans text-xxs font-normal text-bright",
    spacing: "mb-1",
  },
  "extra-extra-small/caps": {
    text: "font-sans text-xxs uppercase tracking-wider font-normal text-dimmed",
    spacing: "mb-1",
  },
  "extra-extra-small/bright/caps": {
    text: "font-sans text-xxs uppercase tracking-wider font-normal text-bright",
    spacing: "mb-1",
  },
};

export type ParagraphVariant = keyof typeof paragraphVariants;

type ParagraphProps = {
  variant?: ParagraphVariant;
  className?: string;
  spacing?: boolean;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLParagraphElement>;

export function Paragraph({
  variant = "base",
  className,
  spacing = false,
  children,
  ...props
}: ParagraphProps) {
  return (
    <p
      className={cn(
        paragraphVariants[variant].text,
        spacing === true && paragraphVariants[variant].spacing,
        className
      )}
      {...props}
    >
      {children}
    </p>
  );
}

type TextLinkProps = {
  href?: string;
  to?: string;
  className?: string;
  trailingIcon?: IconNamesOrString;
  trailingIconClassName?: string;
  children: React.ReactNode;
} & React.AnchorHTMLAttributes<HTMLAnchorElement>;

const classes =
  "text-indigo-500 transition hover:text-indigo-400 inline-flex gap-0.5 items-center group";

export function TextLink({
  href,
  to,
  children,
  className,
  trailingIcon,
  trailingIconClassName,
  ...props
}: TextLinkProps) {
  return to ? (
    <Link to={to} className={cn(classes, className)} {...props}>
      {children}{" "}
      {trailingIcon && (
        <NamedIcon
          name={trailingIcon}
          className={cn("h-4 w-4", trailingIconClassName)}
        />
      )}
    </Link>
  ) : href ? (
    <a href={href} className={cn(classes, className)} {...props}>
      {children}{" "}
      {trailingIcon && (
        <NamedIcon
          name={trailingIcon}
          className={cn("h-4 w-4", trailingIconClassName)}
        />
      )}
    </a>
  ) : (
    <span>Need to define a path or href</span>
  );
}
