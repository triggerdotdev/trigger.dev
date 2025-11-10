import { NavLink } from "@remix-run/react";
import { motion } from "framer-motion";
import { type ReactNode, useRef } from "react";
import { type ShortcutDefinition, useShortcutKeys } from "~/hooks/useShortcutKeys";
import { cn } from "~/utils/cn";
import { ShortcutKey } from "./ShortcutKey";

export type Variants = "underline" | "pipe-divider" | "segmented";

export type TabsProps = {
  tabs: {
    label: string;
    to: string;
  }[];
  className?: string;
  layoutId: string;
  variant?: Variants;
};

export function Tabs({ tabs, className, layoutId, variant = "underline" }: TabsProps) {
  return (
    <TabContainer className={className} variant={variant}>
      {tabs.map((tab, index) => (
        <TabLink key={index} to={tab.to} layoutId={layoutId} variant={variant}>
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
        className={cn("relative flex h-10 items-center rounded bg-charcoal-700/50 p-1", className)}
      >
        {children}
      </div>
    );
  }

  if (variant === "underline") {
    return (
      <div className={cn(`flex gap-x-6 border-b border-grid-bright`, className)}>{children}</div>
    );
  }

  return <div className={cn(`flex`, className)}>{children}</div>;
}

export function TabLink({
  to,
  children,
  layoutId,
  variant = "underline",
}: {
  to: string;
  children: ReactNode;
  layoutId: string;
  variant?: Variants;
}) {
  if (variant === "segmented") {
    return (
      <NavLink
        to={to}
        className="group relative flex h-full grow items-center justify-center focus-custom"
        end
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
                      : "text-text-dimmed transition hover:text-text-bright"
                  )}
                >
                  {children}
                </span>
              </div>
              {active && (
                <motion.div
                  layoutId={layoutId}
                  transition={{ duration: 0.4, type: "spring" }}
                  className="absolute inset-0 rounded-[2px] border border-charcoal-500/50 bg-charcoal-600"
                />
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
        className="group flex flex-col items-center border-r border-charcoal-700 px-2 pt-1 focus-custom first:pl-0 last:border-none"
        end
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
    <NavLink to={to} className="group flex flex-col items-center pt-1 focus-custom" end>
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
              <div className="mt-1 h-0.5 w-full bg-charcoal-500 opacity-0 transition duration-200 group-hover:opacity-100" />
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
  ...props
}: {
  isActive: boolean;
  shortcut?: ShortcutDefinition;
  layoutId: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const ref = useRef<HTMLButtonElement>(null);

  if (shortcut) {
    useShortcutKeys({
      shortcut: shortcut,
      action: () => {
        if (ref.current) {
          ref.current.click();
        }
      },
      disabled: props.disabled,
    });
  }

  return (
    <button
      className={cn(
        "group flex flex-col items-center pt-1 focus-custom",
        props.className,
        props.disabled && "pointer-events-none opacity-50"
      )}
      type="button"
      ref={ref}
      {...props}
    >
      <>
        <div className="flex items-center gap-1">
          <span
            className={cn(
              "text-sm transition duration-200",
              isActive ? "text-text-bright" : "text-text-bright"
            )}
          >
            {props.children}
          </span>
          {shortcut && <ShortcutKey className={cn("")} shortcut={shortcut} variant={"small"} />}
        </div>
        {isActive ? (
          <motion.div layoutId={layoutId} className="mt-1 h-0.5 w-full bg-indigo-500" />
        ) : (
          <div className="mt-1 h-0.5 w-full bg-charcoal-500 opacity-0 transition duration-200 group-hover:opacity-100" />
        )}
      </>
    </button>
  );
}
