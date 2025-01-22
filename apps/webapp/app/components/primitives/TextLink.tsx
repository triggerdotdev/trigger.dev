import { Link } from "@remix-run/react";
import { ReactNode } from "react";
import { cn } from "~/utils/cn";
import { Icon, RenderIcon } from "./Icon";

const variations = {
  primary:
    "text-indigo-500 transition hover:text-indigo-400 inline-flex gap-0.5 items-center group",
  secondary:
    "text-text-dimmed transition underline underline-offset-2 decoration-dimmed/50 hover:decoration-dimmed inline-flex gap-0.5 items-center group",
} as const;

type TextLinkProps = {
  href?: string;
  to?: string;
  className?: string;
  trailingIcon?: RenderIcon;
  trailingIconClassName?: string;
  variant?: keyof typeof variations;
  children: React.ReactNode;
} & React.AnchorHTMLAttributes<HTMLAnchorElement>;

export function TextLink({
  href,
  to,
  children,
  className,
  trailingIcon,
  trailingIconClassName,
  variant = "primary",
  ...props
}: TextLinkProps) {
  const classes = variations[variant];
  return to ? (
    <Link to={to} className={cn(classes, className)} {...props}>
      {children}{" "}
      {trailingIcon && <Icon icon={trailingIcon} className={cn("size-4", trailingIconClassName)} />}
    </Link>
  ) : href ? (
    <a href={href} className={cn(classes, className)} {...props}>
      {children}{" "}
      {trailingIcon && <Icon icon={trailingIcon} className={cn("size-4", trailingIconClassName)} />}
    </a>
  ) : (
    <span>Need to define a path or href</span>
  );
}
