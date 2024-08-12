"use client";

import React from "react";
import { PanelGroup, Panel, PanelResizer } from "react-window-splitter";
import { cn } from "~/utils/cn";

const ResizablePanelGroup = ({ className, ...props }: React.ComponentProps<typeof PanelGroup>) => (
  <PanelGroup
    className={cn("flex w-full data-[panel-group-direction=vertical]:flex-col", className)}
    autosaveStrategy="cookie"
    {...props}
  />
);

const ResizablePanel = Panel;

const ResizableHandle = ({
  withHandle = true,
  className,
  ...props
}: React.ComponentProps<typeof PanelResizer> & {
  withHandle?: boolean;
}) => (
  <PanelResizer
    className={cn(
      "focus-visible:ring-ring group relative flex w-0.75 items-center justify-center after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full data-[panel-group-direction=vertical]:after:left-0 data-[panel-group-direction=vertical]:after:h-1 data-[panel-group-direction=vertical]:after:w-full data-[panel-group-direction=vertical]:after:-translate-y-1/2 data-[panel-group-direction=vertical]:after:translate-x-0 hover:w-0.75 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-offset-1 [&[data-panel-group-direction=vertical]>div]:rotate-90",
      className
    )}
    size="3px"
    {...props}
  >
    <div className="absolute left-[0.0625rem] top-0 h-full w-px bg-grid-bright transition group-hover:left-0 group-hover:w-0.75 group-hover:bg-lavender-500" />
    {withHandle && (
      <div className="z-10 flex h-5 w-3 flex-col items-center justify-center gap-[0.1875rem] bg-background-dimmed group-hover:hidden">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="h-[0.1875rem] w-0.75 rounded-full bg-charcoal-600" />
        ))}
      </div>
    )}
  </PanelResizer>
);

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };

export type ResizableSnapshot = React.ComponentProps<typeof PanelGroup>["snapshot"];
