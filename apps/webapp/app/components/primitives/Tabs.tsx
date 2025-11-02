import { NavLink } from "@remix-run/react";
import { motion } from "framer-motion";
import { type ReactNode, useRef } from "react";
import { type ShortcutDefinition, useShortcutKeys } from "~/hooks/useShortcutKeys";
import { cn } from "~/utils/cn";
import { ShortcutKey } from "./ShortcutKey";

export type TabsProps = {
  tabs: {
    label: string;
    to: string;
  }[];
  className?: string;
  layoutId: string;
};

export function Tabs({ tabs, className, layoutId }: TabsProps) {
  return (
    <TabContainer className={className}>
      {tabs.map((tab, index) => (
        <TabLink key={index} to={tab.to} layoutId={layoutId}>
          {tab.label}
        </TabLink>
      ))}
    </TabContainer>
  );
}

export function TabContainer({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn(`flex flex-row gap-x-6 border-b border-grid-bright`, className)}>
      {children}
    </div>
  );
}

export function TabLink({
  to,
  children,
  layoutId,
}: {
  to: string;
  children: ReactNode;
  layoutId: string;
}) {
  return (
    <NavLink to={to} className="group flex flex-col items-center pt-1 focus-custom" end>
      {({ isActive, isPending }) => {
        return (
          <>
            <span
              className={cn(
                "text-sm transition duration-200",
                isActive || isPending ? "text-text-bright" : "text-text-bright"
              )}
            >
              {children}
            </span>
            {isActive || isPending ? (
              <motion.div layoutId={layoutId} className="mt-1 h-0.5 w-full bg-indigo-500" />
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
