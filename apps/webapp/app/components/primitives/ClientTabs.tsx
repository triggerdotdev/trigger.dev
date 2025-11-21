"use client";

import { motion } from "framer-motion";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as React from "react";
import { cn } from "~/utils/cn";
import { type Variants } from "./Tabs";

type ClientTabsContextValue = {
  value?: string;
};

const ClientTabsContext = React.createContext<ClientTabsContextValue | undefined>(undefined);

function useClientTabsContext() {
  return React.useContext(ClientTabsContext);
}

const ClientTabs = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>
>(({ onValueChange, value: valueProp, defaultValue, ...props }, ref) => {
  const [value, setValue] = React.useState<string | undefined>(valueProp ?? defaultValue);

  React.useEffect(() => {
    if (valueProp !== undefined) {
      setValue(valueProp);
    }
  }, [valueProp]);

  const handleValueChange = React.useCallback(
    (nextValue: string) => {
      if (valueProp === undefined) {
        setValue(nextValue);
      }
      onValueChange?.(nextValue);
    },
    [onValueChange, valueProp]
  );

  const controlledProps =
    valueProp !== undefined
      ? { value: valueProp }
      : defaultValue !== undefined
      ? { defaultValue }
      : {};

  const contextValue = React.useMemo<ClientTabsContextValue>(() => ({ value }), [value]);

  return (
    <ClientTabsContext.Provider value={contextValue}>
      <TabsPrimitive.Root
        ref={ref}
        onValueChange={handleValueChange}
        {...controlledProps}
        {...props}
      />
    </ClientTabsContext.Provider>
  );
});
ClientTabs.displayName = TabsPrimitive.Root.displayName;

const ClientTabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & {
    variant?: Variants;
  }
>(({ className, variant = "pipe-divider", ...props }, ref) => {
  const variantClassName = (() => {
    switch (variant) {
      case "segmented":
        return "relative flex h-10 w-full items-center rounded bg-charcoal-700/50 p-1";
      case "underline":
        return "flex gap-x-6 border-b border-grid-bright";
      default:
        return "inline-flex items-center justify-center transition duration-100";
    }
  })();

  return <TabsPrimitive.List ref={ref} className={cn(variantClassName, className)} {...props} />;
});
ClientTabsList.displayName = TabsPrimitive.List.displayName;

const ClientTabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> & {
    variant?: Variants;
    layoutId?: string;
  }
>(({ className, variant = "pipe-divider", layoutId, children, ...props }, ref) => {
  const context = useClientTabsContext();
  const activeValue = context?.value;
  const isActive = activeValue === props.value;

  if (variant === "segmented") {
    return (
      <TabsPrimitive.Trigger
        ref={ref}
        className={cn(
          "group relative flex h-full grow items-center justify-center focus-custom disabled:pointer-events-none disabled:opacity-50",
          "flex-1 basis-0",
          className
        )}
        {...props}
      >
        <div className="relative z-10 flex h-full w-full items-center justify-center px-3 py-[0.13rem]">
          <span
            className={cn(
              "text-sm transition duration-200",
              isActive
                ? "text-text-bright"
                : "text-text-dimmed transition group-hover:text-text-bright"
            )}
          >
            {children}
          </span>
        </div>
        {isActive ? (
          layoutId ? (
            <motion.div
              layoutId={layoutId}
              transition={{ duration: 0.4, type: "spring" }}
              className="absolute inset-0 rounded-[2px] border border-charcoal-500/50 bg-charcoal-600"
            />
          ) : (
            <div className="absolute inset-0 rounded-[2px] border border-charcoal-500/50 bg-charcoal-600" />
          )
        ) : null}
      </TabsPrimitive.Trigger>
    );
  }

  if (variant === "underline") {
    return (
      <TabsPrimitive.Trigger
        ref={ref}
        className={cn(
          "group flex flex-col items-center pt-1 focus-custom disabled:pointer-events-none disabled:opacity-50",
          className
        )}
        {...props}
      >
        <span
          className={cn(
            "text-sm transition duration-200",
            isActive ? "text-text-bright" : "text-text-dimmed hover:text-text-bright"
          )}
        >
          {children}
        </span>
        {layoutId ? (
          isActive ? (
            <motion.div
              layoutId={layoutId}
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
              className="mt-1 h-0.5 w-full bg-indigo-500"
            />
          ) : (
            <div className="mt-1 h-0.5 w-full bg-charcoal-500 opacity-0 transition duration-200 group-hover:opacity-100" />
          )
        ) : isActive ? (
          <div className="mt-1 h-0.5 w-full bg-indigo-500" />
        ) : (
          <div className="mt-1 h-0.5 w-full bg-charcoal-500 opacity-0 transition duration-200 group-hover:opacity-100" />
        )}
      </TabsPrimitive.Trigger>
    );
  }

  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "ring-offset-background focus-visible:ring-ring inline-flex items-center justify-center whitespace-nowrap border-r border-charcoal-700 px-2 text-sm transition-all first:pl-0 last:border-none data-[state=active]:text-indigo-500 data-[state=inactive]:text-text-dimmed data-[state=inactive]:hover:text-text-bright focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
        className
      )}
      {...props}
    >
      {children}
    </TabsPrimitive.Trigger>
  );
});
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
  variant?: Variants;
};

export { ClientTabs, ClientTabsContent, ClientTabsList, ClientTabsTrigger };
