import { Link } from "@remix-run/react";
import classnames from "classnames";

const commonClasses =
  "inline-flex items-center justify-center max-w-max rounded px-4 py-2 text-sm transition whitespace-nowrap";
const primaryClasses = classnames(
  commonClasses,
  "bg-indigo-700 text-white hover:bg-indigo-600 focus:ring-indigo-800 gap-2"
);
const secondaryClasses = classnames(
  commonClasses,
  "bg-transparent border-2 border-slate-600 text-white hover:bg-black/20 hover:border-slate-700 focus:ring-slate-300 gap-2"
);

const tertiaryClasses = classnames(
  commonClasses,
  "text-white/60 hover:text-white gap-1"
);

type ButtonProps = React.DetailedHTMLProps<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  HTMLButtonElement
>;

type LinkProps = Parameters<typeof Link>[0];

type AProps = React.DetailedHTMLProps<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  HTMLAnchorElement
>;

export function PrimaryButton({ children, className, ...props }: ButtonProps) {
  return (
    <button className={classnames(primaryClasses, className)} {...props}>
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  className,
  ...props
}: ButtonProps) {
  return (
    <button className={classnames(secondaryClasses, className)} {...props}>
      {children}
    </button>
  );
}

export function TertiaryButton({ children, className, ...props }: ButtonProps) {
  return (
    <button className={classnames(tertiaryClasses, className)} {...props}>
      {children}
    </button>
  );
}

export function PrimaryLink({ children, className, to, ...props }: LinkProps) {
  return (
    <Link to={to} className={classnames(primaryClasses, className)} {...props}>
      {children}
    </Link>
  );
}

export function SecondaryLink({
  children,
  className,
  to,
  ...props
}: LinkProps) {
  return (
    <Link
      to={to}
      className={classnames(secondaryClasses, className)}
      {...props}
    >
      {children}
    </Link>
  );
}

export function TertiaryLink({ children, className, to, ...props }: LinkProps) {
  return (
    <Link to={to} className={classnames(tertiaryClasses, className)} {...props}>
      {children}
    </Link>
  );
}

export function PrimaryA({ children, className, href, ...props }: AProps) {
  return (
    <a href={href} className={classnames(primaryClasses, className)} {...props}>
      {children}
    </a>
  );
}

export function SecondaryA({ children, className, href, ...props }: AProps) {
  return (
    <a
      href={href}
      className={classnames(secondaryClasses, className)}
      {...props}
    >
      {children}
    </a>
  );
}

export function TertiaryA({ children, className, href, ...props }: AProps) {
  return (
    <a
      href={href}
      className={classnames(tertiaryClasses, className)}
      {...props}
    >
      {children}
    </a>
  );
}
