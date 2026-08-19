import { NavLink } from "@remix-run/react";
import { motion } from "framer-motion";
import { type ReactNode, useRef } from "react";
import { type ShortcutDefinition, useShortcutKeys } from "~/hooks/useShortcutKeys";
import { cn } from "~/utils/cn";
import { headerVariants } from "./Headers";
import { ShortcutKey } from "./ShortcutKey";

/** `"title"` names the table below it: header2 text, filter-bar height, underline on the border. */
export type Variants = "underline" | "pipe-divider" | "segmented" | "title";

/** Shared with `TitleBar` so the tabbed and tab-less bars match. */
export const TITLE_BAR_CHROME = "flex h-10 shrink-0 gap-x-6 border-b border-grid-bright";

const titleTabLabel = cn(headerVariants.header2.text, "transition duration-200");
const titleTabIndicator = "h-0.5 w-full bg-indigo-500";
const titleTabIndicatorIdle =
  "h-0.5 w-full bg-surface-control-active opacity-0 transition duration-200 group-hover:opacity-100";

export type TabsProps = {
  tabs: {
    label: string;
    to: string;
    end?: boolean;
  }[];
  className?: string;
  layoutId: string;
  variant?: Variants;
};

export function Tabs({ tabs, className, layoutId, variant = "underline" }: TabsProps) {
  return (
    <TabContainer className={className} variant={variant}>
      {tabs.map((tab, index) => (
        <TabLink
          key={index}
          to={tab.to}
          layoutId={layoutId}
          variant={variant}
          end={tab.end ?? true}
        >
          {tab.label}
        </TabLink>
      ))}
    </TabContainer>
  );
}

export function TabContainer({
  children,
  className,
  variant = "underline",
}: {
  children: ReactNode;
  className?: string;
  variant?: Variants;
}) {
  if (variant === "segmented") {
    return (
      <div
        className={cn(
          "relative flex h-10 items-center rounded bg-background-raised/50 p-1",
          className
        )}
      >
        {children}
      </div>
    );
  }

  if (variant === "title") {
    return <div className={cn(TITLE_BAR_CHROME, "items-stretch", className)}>{children}</div>;
  }

  if (variant === "underline") {
    return (
      <div className={cn(`flex gap-x-6 border-b border-grid-bright`, className)}>{children}</div>
    );
  }

  return <div className={cn(`flex`, className)}>{children}</div>;
}

function TabLink({
  to,
  children,
  layoutId,
  variant = "underline",
  end = true,
}: {
  to: string;
  children: ReactNode;
  layoutId: string;
  variant?: Variants;
  end?: boolean;
}) {
  if (variant === "segmented") {
    return (
      <NavLink
        to={to}
        className="group relative flex h-full grow items-center justify-center focus-custom"
        end={end}
      >
        {({ isActive, isPending }) => {
          const active = isActive || isPending;
          return (
            <>
              <div className="relative z-10 flex h-full w-full items-center justify-center px-3 py-[0.13rem]">
                <span
                  className={cn(
                    "text-sm transition duration-200",
                    active
                      ? "text-text-bright"
                      : "text-text-dimmed transition group-hover:text-text-bright"
                  )}
                >
                  {children}
                </span>
              </div>
              {active && (
                <motion.div
                  layoutId={layoutId}
                  transition={{ duration: 0.4, type: "spring" }}
                  className="absolute inset-0 rounded-[2px] border border-border-brightest/50 bg-surface-control"
                />
              )}
            </>
          );
        }}
      </NavLink>
    );
  }

  if (variant === "title") {
    return (
      <NavLink to={to} className="group flex h-full flex-col focus-custom" end={end}>
        {({ isActive, isPending }) => {
          const active = isActive || isPending;
          return (
            <>
              <div className="flex flex-1 items-center">
                <span
                  className={cn(
                    titleTabLabel,
                    active ? "text-text-bright" : "text-text-dimmed group-hover:text-text-bright"
                  )}
                >
                  {children}
                </span>
              </div>
              {active ? (
                <motion.div
                  layoutId={layoutId}
                  transition={{ type: "spring", stiffness: 500, damping: 30 }}
                  className={titleTabIndicator}
                />
              ) : (
                <div className={titleTabIndicatorIdle} />
              )}
            </>
          );
        }}
      </NavLink>
    );
  }

  if (variant === "pipe-divider") {
    return (
      <NavLink
        to={to}
        className="group flex flex-col items-center border-r border-grid-bright px-2 pt-1 focus-custom first:pl-0 last:border-none"
        end={end}
      >
        {({ isActive, isPending }) => {
          const active = isActive || isPending;
          return (
            <span
              className={cn(
                "text-sm transition duration-200",
                active ? "text-text-link" : "text-text-dimmed transition hover:text-text-bright"
              )}
            >
              {children}
            </span>
          );
        }}
      </NavLink>
    );
  }

  // underline variant (default)
  return (
    <NavLink to={to} className="group flex flex-col items-center pt-1 focus-custom" end={end}>
      {({ isActive, isPending }) => {
        return (
          <>
            <span
              className={cn(
                "text-sm transition duration-200",
                isActive || isPending
                  ? "text-text-bright"
                  : "text-text-dimmed hover:text-text-bright"
              )}
            >
              {children}
            </span>
            {isActive || isPending ? (
              <motion.div
                layoutId={layoutId}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
                className="mt-1 h-0.5 w-full bg-indigo-500"
              />
            ) : (
              <div className="mt-1 h-0.5 w-full bg-surface-control-active opacity-0 transition duration-200 group-hover:opacity-100" />
            )}
          </>
        );
      }}
    </NavLink>
  );
}

export function TabButton({
  isActive,
  layoutId,
  shortcut,
  variant = "underline",
  ...props
}: {
  isActive: boolean;
  shortcut?: ShortcutDefinition;
  layoutId: string;
  variant?: Variants;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const ref = useRef<HTMLButtonElement>(null);

  useShortcutKeys({
    shortcut,
    action: () => {
      if (ref.current) {
        ref.current.click();
      }
    },
    disabled: props.disabled,
  });

  const title = variant === "title";

  return (
    <button
      className={cn(
        "group flex flex-col items-center focus-custom",
        title ? "h-full" : "pt-1",
        props.className,
        props.disabled && "pointer-events-none opacity-50"
      )}
      type="button"
      ref={ref}
      {...props}
    >
      <>
        <div className={cn("flex items-center gap-1", title && "flex-1")}>
          <span
            className={cn(
              "transition duration-200",
              title
                ? cn(
                    headerVariants.header2.text,
                    isActive ? "text-text-bright" : "text-text-dimmed group-hover:text-text-bright"
                  )
                : "text-sm text-text-bright"
            )}
          >
            {props.children}
          </span>
          {shortcut && <ShortcutKey className={cn("")} shortcut={shortcut} variant={"small"} />}
        </div>
        {isActive ? (
          <motion.div
            layoutId={layoutId}
            transition={{ type: "spring", stiffness: 500, damping: 30 }}
            className={cn("h-0.5 w-full bg-indigo-500", !title && "mt-1")}
          />
        ) : (
          <div
            className={cn(
              "h-0.5 w-full bg-surface-control-active opacity-0 transition duration-200 group-hover:opacity-100",
              !title && "mt-1"
            )}
          />
        )}
      </>
    </button>
  );
}
