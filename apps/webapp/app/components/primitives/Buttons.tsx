import { Link } from "@remix-run/react";
import classnames from "classnames";

type Size = "regular" | "large";

const commonClasses =
  "inline-flex items-center justify-center max-w-max rounded transition whitespace-nowrap";
const primaryClasses = classnames(
  commonClasses,
  "px-4 py-2 bg-indigo-700 text-white hover:bg-indigo-600 focus-visible:ring-indigo-800 gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
);
const secondaryClasses = classnames(
  commonClasses,
  "px-4 py-2 bg-transparent ring-1 ring-slate-700 ring-inset text-white hover:bg-white/5 hover:border-slate-700 focus-visible:ring-slate-300 gap-2"
);
const tertiaryClasses = classnames(
  commonClasses,
  "text-slate-300/70 hover:text-white gap-1"
);
const dangerClasses = classnames(
  commonClasses,
  "px-4 py-2 bg-rose-700 text-white hover:bg-rose-600 focus-visible:ring-rose-800 gap-2"
);
const toxicClasses = classnames(
  commonClasses,
  "hover:cursor-pointer px-3 py-1 transition bg-gradient-to-r from-acid-500 to-toxic-500 text-slate-1000 !text-base font-bold hover:from-acid-600 hover:to-toxic-600 focus-visible:ring-slate-300"
);

function getSizeClassName(size: Size) {
  switch (size) {
    case "large":
      return "text-lg";
    case "regular":
    default:
      return "text-sm";
  }
}

type ButtonProps = React.DetailedHTMLProps<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  HTMLButtonElement
> & {
  size?: Size;
};

type LinkProps = Parameters<typeof Link>[0] & {
  size?: Size;
};

type AProps = React.DetailedHTMLProps<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  HTMLAnchorElement
> & {
  size?: Size;
};

export function PrimaryButton({
  children,
  size = "regular",
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      className={classnames(primaryClasses, getSizeClassName(size), className)}
      {...props}
    >
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  size = "regular",
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      className={classnames(
        secondaryClasses,
        getSizeClassName(size),
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function TertiaryButton({
  children,
  size = "regular",
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      className={classnames(tertiaryClasses, getSizeClassName(size), className)}
      {...props}
    >
      {children}
    </button>
  );
}

export function DangerButton({
  children,
  size = "regular",
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      className={classnames(dangerClasses, getSizeClassName(size), className)}
      {...props}
    >
      {children}
    </button>
  );
}

export function PrimaryLink({
  children,
  size = "regular",
  className,
  to,
  ...props
}: LinkProps) {
  return (
    <Link
      to={to}
      className={classnames(primaryClasses, getSizeClassName(size), className)}
      {...props}
    >
      {children}
    </Link>
  );
}

export function SecondaryLink({
  children,
  className,
  size = "regular",
  to,
  ...props
}: LinkProps) {
  return (
    <Link
      to={to}
      className={classnames(
        secondaryClasses,
        getSizeClassName(size),
        className
      )}
      {...props}
    >
      {children}
    </Link>
  );
}

export function TertiaryLink({
  children,
  className,
  size = "regular",
  to,
  ...props
}: LinkProps) {
  return (
    <Link
      to={to}
      className={classnames(tertiaryClasses, getSizeClassName(size), className)}
      {...props}
    >
      {children}
    </Link>
  );
}

export function DangerLink({
  children,
  className,
  size = "regular",
  to,
  ...props
}: LinkProps) {
  return (
    <Link
      to={to}
      className={classnames(dangerClasses, getSizeClassName(size), className)}
      {...props}
    >
      {children}
    </Link>
  );
}

export function ToxicLink({
  children,
  className,
  size = "regular",
  to,
  ...props
}: LinkProps) {
  return (
    <Link
      to={to}
      className={classnames(toxicClasses, getSizeClassName(size), className)}
      {...props}
    >
      {children}
    </Link>
  );
}

export function PrimaryA({
  children,
  className,
  size = "regular",
  href,
  ...props
}: AProps) {
  return (
    <a
      href={href}
      className={classnames(primaryClasses, getSizeClassName(size), className)}
      {...props}
    >
      {children}
    </a>
  );
}

export function SecondaryA({
  children,
  className,
  size = "regular",
  href,
  ...props
}: AProps) {
  return (
    <a
      href={href}
      className={classnames(
        secondaryClasses,
        getSizeClassName(size),
        className
      )}
      {...props}
    >
      {children}
    </a>
  );
}

export function TertiaryA({
  children,
  className,
  size = "regular",
  href,
  ...props
}: AProps) {
  return (
    <a
      href={href}
      className={classnames(tertiaryClasses, getSizeClassName(size), className)}
      {...props}
    >
      {children}
    </a>
  );
}

export function ToxicA({
  children,
  className,
  size = "regular",
  href,
  ...props
}: AProps) {
  return (
    <a
      href={href}
      className={classnames(toxicClasses, getSizeClassName(size), className)}
      {...props}
    >
      {children}
    </a>
  );
}
