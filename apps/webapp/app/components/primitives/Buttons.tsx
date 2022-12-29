import { Link } from "@remix-run/react";
import classnames from "classnames";

const commonClasses =
  "inline-flex items-center justify-center rounded max-w-max px-4 py-2 gap-2 text-sm transition whitespace-nowrap";
const primaryClasses = classnames(
  commonClasses,
  "bg-blue-600 text-white hover:bg-blue-700 focus:bg-blue-700"
);
const secondaryClasses = classnames(
  commonClasses,
  "bg-indigo-900 text-white hover:bg-indigo-800 focus:bg-indigo-800"
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
