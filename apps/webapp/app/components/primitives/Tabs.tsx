import { NavLink, useLocation } from "@remix-run/react";
import { motion } from "framer-motion";
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
    <div className={cn(`flex flex-row gap-x-6 border-b border-grid-bright`, className)}>
      {tabs.map((tab, index) => (
        <NavLink key={index} to={tab.to} className="group flex flex-col items-center pt-1" end>
          {({ isActive, isPending }) => (
            <>
              <span
                className={cn(
                  "text-sm transition duration-200",
                  isActive || isPending ? "text-indigo-500" : "text-charcoal-200"
                )}
              >
                {tab.label}
              </span>
              {isActive || isPending ? (
                <motion.div layoutId={layoutId} className="mt-1 h-0.5 w-full bg-indigo-500" />
              ) : (
                <div className="mt-1 h-0.5 w-full bg-charcoal-500 opacity-0 transition duration-200 group-hover:opacity-100" />
              )}
            </>
          )}
        </NavLink>
      ))}
    </div>
  );
}
