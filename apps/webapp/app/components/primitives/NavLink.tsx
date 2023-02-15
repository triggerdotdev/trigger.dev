import { Link } from "@remix-run/react";
import classnames from "classnames";

type NavLinkProps = Parameters<typeof Link>[0];

export function NavLink({
  to,
  children,
  target,
  className,
  onClick,
  ...props
}: NavLinkProps) {
  return (
    <Link
      to={to}
      {...props}
      onClick={onClick}
      target={target}
      className={classnames(
        "hover:text-toxic-500 inline-block whitespace-nowrap py-1 text-sm text-slate-200 transition md:px-2",
        { className }
      )}
    >
      {children}
    </Link>
  );
}

export function MobileNavLink({
  to,
  children,
  className,
  onClick,
  ...props
}: NavLinkProps) {
  return (
    <Link
      to={to}
      {...props}
      onClick={onClick}
      className={classnames(
        "hover:text-toxic-500 text-s block w-full whitespace-nowrap rounded-lg bg-slate-900 p-2 text-center text-sm text-slate-50 transition",
        { className }
      )}
    >
      {children}
    </Link>
  );
}

export function MobileNavIcon({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5 overflow-visible stroke-slate-300"
      fill="none"
      strokeWidth={2}
      strokeLinecap="round"
    >
      <path
        d="M0 1H14M0 7H14M0 13H14"
        className={classnames(
          "origin-center transition",
          open && "scale-90 opacity-0"
        )}
      />
      <path
        d="M2 2L12 12M12 2L2 12"
        className={classnames(
          "origin-center transition",
          !open && "scale-90 opacity-0"
        )}
      />
    </svg>
  );
}
