import { Link } from "@remix-run/react";
import classnames from "classnames";

const commonClasses =
  "inline-flex items-center justify-center max-w-max rounded text-sm transition whitespace-nowrap";
const primaryClasses = classnames(
  commonClasses,
  "px-4 py-2 bg-indigo-700 text-white hover:bg-indigo-600 focus:ring-indigo-800 gap-2"
);
const secondaryClasses = classnames(
  commonClasses,
  "px-4 py-2 bg-transparent ring-1 ring-slate-700 ring-inset text-white hover:bg-white/5 hover:border-slate-700 focus:ring-slate-300 gap-2"
);
const tertiaryClasses = classnames(
  commonClasses,
  "text-slate-300/70 hover:text-white gap-1"
);
const dangerClasses = classnames(
  commonClasses,
  "px-4 py-2 bg-rose-700 text-white hover:bg-rose-600 focus:ring-rose-800 gap-2"
);
const toxicClasses = classnames(
  commonClasses,
  "px-3 py-1 bg-gradient-to-r from-acid-500 to-toxic-500 text-slate-1000 !text-base font-bold hover:from-acid-600 hover:to-toxic-600 focus:ring-slate-300"
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

export function DangerButton({ children, className, ...props }: ButtonProps) {
  return (
    <button className={classnames(dangerClasses, className)} {...props}>
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

export function DangerLink({ children, className, to, ...props }: LinkProps) {
  return (
    <Link to={to} className={classnames(dangerClasses, className)} {...props}>
      {children}
    </Link>
  );
}

export function ToxicLink({ children, className, to, ...props }: LinkProps) {
  return (
    <Link to={to} className={classnames(toxicClasses, className)} {...props}>
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
