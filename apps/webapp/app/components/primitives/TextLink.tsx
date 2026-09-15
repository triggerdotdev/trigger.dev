import { Link } from "@remix-run/react";
import { cn } from "~/utils/cn";
import { Icon, type RenderIcon } from "./Icon";
import { useRef } from "react";
import { type ShortcutDefinition, useShortcutKeys } from "~/hooks/useShortcutKeys";
import { ShortcutKey } from "./ShortcutKey";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./Tooltip";

/* Hover shifts colour, never adds an underline: that's reserved for the
   "Underline links" preference, so its presence always means the preference. */
const colors = {
  primary: "text-text-link transition hover:text-text-link-hover",
  secondary: "text-text-dimmed transition hover:text-text-bright",
} as const;

const layout = "inline-flex gap-0.5 items-center group";

/**
 * A link's colour plus the `inline-text-link` marker, without the layout - for
 * links that must stay in the inline flow, and triggers that aren't anchors.
 */
export function textLinkClassName(variant: keyof typeof colors = "primary") {
  return cn("inline-text-link focus-visible:focus-custom", colors[variant]);
}

const variations = {
  primary: cn(textLinkClassName("primary"), layout),
  secondary: cn(textLinkClassName("secondary"), layout),
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
  /** Forwarded to `Link`: forces a full document load rather than a client nav. */
  reloadDocument?: boolean;
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
  reloadDocument,
  ...props
}: TextLinkProps) {
  const innerRef = useRef<HTMLAnchorElement>(null);
  const classes = variations[variant];

  useShortcutKeys({
    shortcut,
    action: () => {
      if (innerRef.current) {
        innerRef.current.click();
      }
    },
  });

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
    <Link
      ref={innerRef}
      to={to}
      reloadDocument={reloadDocument}
      className={cn(classes, className)}
      {...props}
    >
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
