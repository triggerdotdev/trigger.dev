"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "~/utils/cn";
import { motion } from "framer-motion";

const ClientTabs = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>
>((props, ref) => <TabsPrimitive.Root ref={ref} {...props} />);
ClientTabs.displayName = TabsPrimitive.Root.displayName;

const ClientTabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn("inline-flex items-center justify-center transition duration-100", className)}
    {...props}
  />
));
ClientTabsList.displayName = TabsPrimitive.List.displayName;

const ClientTabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "ring-offset-background focus-visible:ring-ring inline-flex items-center justify-center whitespace-nowrap border-r border-charcoal-700 px-2 text-sm transition-all first:pl-0 last:border-none data-[state=active]:text-indigo-500 data-[state=inactive]:text-text-dimmed data-[state=inactive]:hover:text-text-bright focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
      className
    )}
    {...props}
  />
));
ClientTabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const ClientTabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "ring-offset-background focus-visible:ring-ring mt-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
      className
    )}
    {...props}
  />
));
ClientTabsContent.displayName = TabsPrimitive.Content.displayName;

export type TabsProps = {
  tabs: {
    label: string;
    value: string;
  }[];
  currentValue: string;
  className?: string;
  layoutId: string;
};

export function ClientTabsWithUnderline({ className, tabs, currentValue, layoutId }: TabsProps) {
  return (
    <TabsPrimitive.List
      className={cn(`flex flex-row gap-x-6 border-b border-charcoal-700`, className)}
    >
      {tabs.map((tab, index) => {
        const isActive = currentValue === tab.value;
        return (
          <TabsPrimitive.Trigger
            key={tab.value}
            value={tab.value}
            className={cn(`group flex flex-col items-center`, className)}
          >
            <span
              className={cn(
                "text-sm transition duration-200",
                isActive ? "text-indigo-500" : "text-charcoal-200"
              )}
            >
              {tab.label}
            </span>
            {isActive ? (
              <motion.div layoutId={layoutId} className="mt-1 h-0.5 w-full bg-indigo-500" />
            ) : (
              <div className="mt-1 h-0.5 w-full bg-charcoal-500 opacity-0 transition duration-200 group-hover:opacity-100" />
            )}
          </TabsPrimitive.Trigger>
        );
      })}
    </TabsPrimitive.List>
  );
}

export { ClientTabs, ClientTabsList, ClientTabsTrigger, ClientTabsContent };
