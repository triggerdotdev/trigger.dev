import { Link } from "@remix-run/react";
import { cn } from "~/utils/cn";
import { Icon, type RenderIcon } from "./Icon";
import { useRef } from "react";
import { type ShortcutDefinition, useShortcutKeys } from "~/hooks/useShortcutKeys";
import { ShortcutKey } from "./ShortcutKey";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./Tooltip";

const variations = {
  primary:
    "text-indigo-500 transition hover:text-indigo-400 inline-flex gap-0.5 items-center group focus-visible:focus-custom",
  secondary:
    "text-text-dimmed transition hover:text-text-bright inline-flex gap-0.5 items-center group focus-visible:focus-custom",
} as const;

type TextLinkProps = {
  href?: string;
  to?: string;
  className?: string;
  trailingIcon?: RenderIcon;
  trailingIconClassName?: string;
  variant?: keyof typeof variations;
  children: React.ReactNode;
  shortcut?: ShortcutDefinition;
  hideShortcutKey?: boolean;
  tooltip?: React.ReactNode;
} & React.AnchorHTMLAttributes<HTMLAnchorElement>;

export function TextLink({
  href,
  to,
  children,
  className,
  trailingIcon,
  trailingIconClassName,
  variant = "primary",
  shortcut,
  hideShortcutKey,
  tooltip,
  ...props
}: TextLinkProps) {
  const innerRef = useRef<HTMLAnchorElement>(null);
  const classes = variations[variant];

  if (shortcut) {
    useShortcutKeys({
      shortcut: shortcut,
      action: () => {
        if (innerRef.current) {
          innerRef.current.click();
        }
      },
    });
  }

  const renderShortcutKey = () =>
    shortcut &&
    !hideShortcutKey && <ShortcutKey className="ml-1.5" shortcut={shortcut} variant="small" />;

  const linkContent = (
    <>
      {children}{" "}
      {trailingIcon && <Icon icon={trailingIcon} className={cn("size-4", trailingIconClassName)} />}
      {shortcut && !tooltip && renderShortcutKey()}
    </>
  );

  const linkElement = to ? (
    <Link ref={innerRef} to={to} className={cn(classes, className)} {...props}>
      {linkContent}
    </Link>
  ) : href ? (
    <a ref={innerRef} href={href} className={cn(classes, className)} {...props}>
      {linkContent}
    </a>
  ) : (
    <span>Need to define a path or href</span>
  );

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{linkElement}</TooltipTrigger>
          <TooltipContent className="text-dimmed flex items-center gap-3 py-1.5 pl-2.5 pr-3 text-xs">
            {tooltip} {shortcut && renderShortcutKey()}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return linkElement;
}
