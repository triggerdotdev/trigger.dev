"use client";

import React from "react";
import { PanelGroup, Panel, PanelResizer } from "react-window-splitter";
import { cn } from "~/utils/cn";

const ResizablePanelGroup = ({ className, ...props }: React.ComponentProps<typeof PanelGroup>) => (
  <PanelGroup
    className={cn(
      "flex w-full overflow-hidden data-[panel-group-direction=vertical]:flex-col",
      className
    )}
    autosaveStrategy={props.autosaveId ? "cookie" : undefined}
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
      // Base styles
      "group relative flex items-center justify-center focus-custom",
      // Horizontal orientation (default)
      "w-0.75 after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2",
      // Vertical orientation
      "data-[handle-orientation=vertical]:h-0.75 data-[handle-orientation=vertical]:w-full",
      "data-[handle-orientation=vertical]:after:inset-x-0 data-[handle-orientation=vertical]:after:inset-y-auto",
      "data-[handle-orientation=vertical]:after:top-1/2 data-[handle-orientation=vertical]:after:left-0",
      "data-[handle-orientation=vertical]:after:h-1 data-[handle-orientation=vertical]:after:w-full",
      "data-[handle-orientation=vertical]:after:-translate-y-1/2 data-[handle-orientation=vertical]:after:translate-x-0",
      className
    )}
    size="3px"
    {...props}
  >
    {/* Horizontal orientation line indicator */}
    <div className="absolute left-[0.0625rem] top-0 h-full w-px bg-grid-bright transition group-hover:left-0 group-hover:w-0.75 group-hover:bg-lavender-500 group-data-[handle-orientation=vertical]:hidden" />
    {/* Vertical orientation line indicator */}
    <div className="absolute left-0 top-[0.0625rem] hidden h-px w-full bg-grid-bright transition group-hover:top-0 group-hover:h-0.75 group-hover:bg-lavender-500 group-data-[handle-orientation=vertical]:block" />
    {withHandle && (
      <>
        {/* Horizontal orientation dots (vertical arrangement) */}
        <div className="z-10 flex h-5 w-0.75 flex-col items-center justify-center gap-[0.1875rem] bg-background-dimmed group-hover:hidden group-data-[handle-orientation=vertical]:hidden">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-[0.1875rem] w-0.75 rounded-full bg-charcoal-600" />
          ))}
        </div>
        {/* Vertical orientation dots (horizontal arrangement) */}
        <div className="z-10 hidden h-0.75 w-5 flex-row items-center justify-center gap-[0.1875rem] bg-background-dimmed group-hover:hidden group-data-[handle-orientation=vertical]:flex">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-0.75 w-[0.1875rem] rounded-full bg-charcoal-600" />
          ))}
        </div>
      </>
    )}
  </PanelResizer>
);

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };

export type ResizableSnapshot = React.ComponentProps<typeof PanelGroup>["snapshot"];
