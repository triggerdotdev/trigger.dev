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
  const isActive =
    isActiveOverride ??
    (pathName === to && (!yieldActiveToFavorite || activeFavoriteId === undefined));

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
