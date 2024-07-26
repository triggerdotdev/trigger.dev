import { NavLink, useLocation } from "@remix-run/react";
import { motion } from "framer-motion";
import { ReactNode } from "react";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { cn } from "~/utils/cn";

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
  const location = useOptimisticLocation();
  const toSearch = to.split("?").at(0);

  return (
    <NavLink to={to} className="group flex flex-col items-center pt-1" end>
      {({ isActive, isPending }) => {
        const isActiveWithQuery = isActive && location.search;

        return (
          <>
            <span
              className={cn(
                "text-sm transition duration-200",
                isActive || isPending ? "text-indigo-500" : "text-charcoal-200"
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
