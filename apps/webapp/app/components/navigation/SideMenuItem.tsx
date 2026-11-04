import {
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  forwardRef,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link } from "@remix-run/react";
import { motion } from "framer-motion";
import { usePathName } from "~/hooks/usePathName";
import { cn } from "~/utils/cn";
import { type RenderIcon, Icon } from "../primitives/Icon";
import { labelOverflowFadeStyle } from "../primitives/labelOverflowFade";
import { SimpleTooltip } from "../primitives/Tooltip";
import { useActiveFavoriteId } from "./favoritePages";

/**
 * A menu label that fades out at its right edge when (and only when) the text overflows. Text
 * that fits renders exactly as before, with no mask. Overflow is re-measured when the element
 * resizes (e.g. while drag-resizing the menu) and when the label text changes.
 */
export function SideMenuLabel({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const checkRef = useRef<() => void>(() => {});

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setIsOverflowing(el.scrollWidth > el.clientWidth + 1);
    checkRef.current = check;
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Re-measure when the text changes (a rename can flip overflow without resizing the element)
  useEffect(() => {
    checkRef.current();
  }, [children]);

  return (
    <span
      ref={ref}
      className={cn("overflow-hidden whitespace-nowrap", className)}
      style={{ ...style, ...labelOverflowFadeStyle(isOverflowing) }}
    >
      {children}
    </span>
  );
}

/**
 * Normalizes a URL path by stripping any hash, query parameters, and trailing slashes.
 */
export function normalizePath(path: string): string {
  const [clean = ""] = path.split("#")[0].split("?");
  if (clean.length > 1 && clean.endsWith("/")) {
    return clean.slice(0, -1);
  }
  return clean;
}

/**
 * Checks whether currentPath matches targetPath, optionally checking nested paths
 * while respecting segment boundaries.
 */
export function matchesPath(currentPath: string, targetPath: string, matchPrefix = false): boolean {
  const normalizedCurrent = normalizePath(currentPath);
  const normalizedTarget = normalizePath(targetPath);

  if (normalizedCurrent === normalizedTarget) {
    return true;
  }

  if (matchPrefix) {
    return normalizedCurrent.startsWith(`${normalizedTarget}/`);
  }

  return false;
}

export type IsSideMenuItemActiveOptions = {
  currentPath: string;
  targetPath: string;
  matchPrefix?: boolean;
  nestedPaths?: string[];
  isActiveOverride?: boolean;
  yieldActiveToFavorite?: boolean;
  activeFavoriteId?: string;
};

/**
 * Determines whether a sidebar navigation item should be marked active.
 *
 * Respects:
 * - Direct isActive overrides (e.g. from favorites).
 * - Yielding active highlight to a matching active favorite.
 * - Exact path matching.
 * - Segment-boundary-aware prefix matching (e.g. /concurrency does NOT match /concurrency-limits).
 * - Nested paths for parent items whose subpages live under distinct paths (e.g. Tasks).
 */
export function isSideMenuItemActive({
  currentPath,
  targetPath,
  matchPrefix = false,
  nestedPaths,
  isActiveOverride,
  yieldActiveToFavorite = false,
  activeFavoriteId,
}: IsSideMenuItemActiveOptions): boolean {
  if (isActiveOverride !== undefined) {
    return isActiveOverride;
  }

  if (yieldActiveToFavorite && activeFavoriteId !== undefined) {
    return false;
  }

  if (matchesPath(currentPath, targetPath, matchPrefix)) {
    return true;
  }

  if (nestedPaths && nestedPaths.length > 0) {
    const normalizedTarget = normalizePath(targetPath);
    for (const nested of nestedPaths) {
      const resolved =
        nested.startsWith("/") && !nested.startsWith(normalizedTarget)
          ? `${normalizedTarget}${nested}`
          : nested;
      if (matchesPath(currentPath, resolved, true)) {
        return true;
      }
    }
  }

  return false;
}

export function SideMenuItem({
  icon,
  activeIconColor,
  inactiveIconColor,
  iconClassName,
  trailingIcon,
  trailingIconClassName,
  name,
  nameClassName,
  to,
  badge,
  target,
  isCollapsed = false,
  action,
  disableIconHover = false,
  indented = false,
  isActive: isActiveOverride,
  yieldActiveToFavorite = false,
  matchPrefix = false,
  nestedPaths,
  "data-action": dataAction,
}: {
  icon?: RenderIcon;
  activeIconColor?: string;
  inactiveIconColor?: string;
  iconClassName?: string;
  trailingIcon?: RenderIcon;
  trailingIconClassName?: string;
  name: string;
  nameClassName?: string;
  to: string;
  badge?: ReactNode;
  target?: AnchorHTMLAttributes<HTMLAnchorElement>["target"];
  isCollapsed?: boolean;
  action?: ReactNode;
  disableIconHover?: boolean;
  /** Indented variant for grouped sub-items; only applied when the menu is expanded. */
  indented?: boolean;
  /** Overrides the default pathname === to active check (e.g. favorites match on full URL). */
  isActive?: boolean;
  matchPrefix?: boolean;
  /** Additional subpaths (e.g. /tasks, /agents) that should activate this parent item. */
  nestedPaths?: string[];
  /**
   * In menus that render the Favorites section (the main project menu), an active favorite owns
   * the highlight, so the plain item yields its active state to it. Menus without a favorites
   * list (org settings, account) must not set this: they have no favorite item to carry the
   * highlight instead.
   */
  yieldActiveToFavorite?: boolean;
  "data-action"?: string;
}) {
  const pathName = usePathName();
  // Only the user's OWN favorites own a view (via the marker param); markers from shared links
  // don't count (see useActiveFavoriteId).
  const activeFavoriteId = useActiveFavoriteId();
  const isActive = isSideMenuItemActive({
    currentPath: pathName,
    targetPath: to,
    matchPrefix,
    nestedPaths,
    isActiveOverride,
    yieldActiveToFavorite,
    activeFavoriteId,
  });

  const isIndented = indented && !isCollapsed;

  const linkElement = (
    <Link
      to={to}
      target={target}
      data-action={dataAction}
      className={cn(
        "group/menulink flex h-8 items-center gap-2 overflow-hidden rounded pl-1.75 pr-2 focus-custom",
        isIndented ? "min-w-0 flex-1" : "w-full",
        isActive
          ? "bg-tertiary text-text-bright"
          : "text-text-dimmed group-hover/menuitem:bg-background-hover group-hover/menuitem:text-text-bright hover:bg-background-hover hover:text-text-bright"
      )}
    >
      <Icon
        icon={icon}
        className={cn(
          "size-5 shrink-0",
          // side-menu-active-icon: System themes neutralize the accent (see tailwind.css)
          isActive
            ? cn(activeIconColor, "side-menu-active-icon")
            : (inactiveIconColor ?? "text-text-dimmed"),
          !isActive &&
            !disableIconHover &&
            "group-hover/menuitem:text-text-bright group-hover/menulink:text-text-bright",
          iconClassName
        )}
      />
      <motion.div
        className="min-w-0 flex-1 overflow-hidden"
        initial={false}
        animate={{
          width: isCollapsed ? 0 : "auto",
        }}
        transition={{ duration: 0.2, ease: "easeOut" }}
      >
        {/*
          Label opacity follows --sm-label-opacity so it fades as the menu narrows (unset
          elsewhere → 1, fully visible).
        */}
        <div
          className="flex w-full min-w-0 items-center justify-between"
          style={{ opacity: "var(--sm-label-opacity, 1)" }}
        >
          <SideMenuLabel
            className={cn(
              "min-w-0 flex-1 select-none text-left text-[0.90625rem] font-medium tracking-[-0.01em]",
              nameClassName
            )}
          >
            {name}
          </SideMenuLabel>
          {badge && !isCollapsed && (
            <div className="ml-1 flex shrink-0 items-center gap-1">{badge}</div>
          )}
          {trailingIcon && !isCollapsed && (
            <Icon
              icon={trailingIcon}
              className={cn("ml-1 size-4 shrink-0", trailingIconClassName)}
            />
          )}
        </div>
      </motion.div>
    </Link>
  );

  const link = isIndented ? (
    <div className="flex w-full">
      <div aria-hidden className="w-3 shrink-0" />
      {linkElement}
    </div>
  ) : (
    linkElement
  );

  if (action) {
    return (
      <div className="group/menuitem relative h-8 w-full">
        <SimpleTooltip
          button={link}
          content={name}
          side="right"
          sideOffset={8}
          buttonClassName="h-8! block w-full"
          hidden={!isCollapsed}
          asChild
          tabbable
          disableHoverableContent
        />
        {!isCollapsed && (
          // Fades with the labels via --sm-label-opacity (unset → fully visible).
          <div
            className={cn(
              "absolute bottom-1 right-1 top-1 flex aspect-square items-center justify-center rounded",
              isActive
                ? "group-hover/menuitem:bg-tertiary"
                : "group-hover/menuitem:bg-background-hover"
            )}
            style={{ opacity: "var(--sm-label-opacity, 1)" }}
          >
            {action}
          </div>
        )}
      </div>
    );
  }

  return (
    <SimpleTooltip
      button={link}
      content={name}
      side="right"
      sideOffset={8}
      buttonClassName="h-8! block w-full"
      hidden={!isCollapsed}
      asChild
      tabbable
      disableHoverableContent
    />
  );
}

/** Button styled to match {@link SideMenuItem}, for entries that open a dialog rather than navigate. */
/* oxlint-disable react/button-has-type -- Callers can select button, reset, or submit semantics. */
export const SideMenuItemButton = forwardRef<
  HTMLButtonElement,
  {
    icon: RenderIcon;
    name: string;
    trailing?: ReactNode;
    iconClassName?: string;
  } & ButtonHTMLAttributes<HTMLButtonElement>
>(function SideMenuItemButton(
  { icon, name, trailing, className, iconClassName, type, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(
        "group/menuitem flex h-8 w-full items-center gap-2 overflow-hidden rounded pl-1.75 pr-2 text-left text-text-dimmed hover:bg-background-hover hover:text-text-bright focus-custom",
        className
      )}
      {...props}
    >
      <Icon
        icon={icon}
        className={cn(
          "size-5 shrink-0",
          iconClassName ?? "text-text-dimmed group-hover/menuitem:text-text-bright"
        )}
      />
      <SideMenuLabel className="min-w-0 flex-1 select-none text-left text-[0.90625rem] font-medium tracking-[-0.01em]">
        {name}
      </SideMenuLabel>
      {trailing && <span className="flex shrink-0 items-center gap-1">{trailing}</span>}
    </button>
  );
});
/* oxlint-enable react/button-has-type */
