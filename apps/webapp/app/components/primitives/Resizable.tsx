"use client";

import React, { useRef } from "react";
import { PanelGroup, Panel, PanelResizer } from "react-window-splitter";
import { cn } from "~/utils/cn";

const ResizablePanelGroup = ({ className, ...props }: React.ComponentProps<typeof PanelGroup>) => (
  <PanelGroup
    className={cn(
      "flex w-full overflow-hidden data-[panel-group-direction=vertical]:flex-col",
      className
    )}
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
    onMouseDown={(e: React.MouseEvent) => {
      e.preventDefault();
    }}
    className={cn(
      "group relative flex items-center justify-center focus-custom",
      // Horizontal size
      "w-0.75",
      // Vertical size
      "data-[handle-orientation=vertical]:h-0.75 data-[handle-orientation=vertical]:w-full",
      // Normal-state line (::before) — 1px, centered in the 3px handle
      "before:absolute before:left-px before:top-0 before:h-full before:w-px before:bg-grid-bright",
      "data-[handle-orientation=vertical]:before:left-0 data-[handle-orientation=vertical]:before:top-px data-[handle-orientation=vertical]:before:h-px data-[handle-orientation=vertical]:before:w-full",
      // Hit area (::after pseudo) for easier grabbing
      "after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2",
      "data-[handle-orientation=vertical]:after:inset-x-0 data-[handle-orientation=vertical]:after:inset-y-auto",
      "data-[handle-orientation=vertical]:after:left-0 data-[handle-orientation=vertical]:after:top-1/2",
      "data-[handle-orientation=vertical]:after:h-3 data-[handle-orientation=vertical]:after:w-full",
      "data-[handle-orientation=vertical]:after:-translate-y-1/2 data-[handle-orientation=vertical]:after:translate-x-0",
      className
    )}
    size="3px"
    {...props}
  >
    {/* Indigo hover overlay — absolutely positioned on top of everything */}
    <div className="pointer-events-none absolute left-0 top-0 z-10 h-full w-0.75 bg-indigo-500 opacity-0 transition-opacity group-hover:opacity-100 group-data-[handle-orientation=vertical]:hidden" />
    <div className="pointer-events-none absolute left-0 top-0 z-10 hidden h-0.75 w-full bg-indigo-500 opacity-0 transition-opacity group-hover:opacity-100 group-data-[handle-orientation=vertical]:block" />
    {withHandle && (
      <>
        {/* Horizontal orientation dots (vertical arrangement) */}
        <div className="relative z-[1] flex h-5 w-0.75 flex-col items-center justify-center gap-[0.1875rem] bg-background-dimmed transition-opacity group-hover:opacity-0 group-data-[handle-orientation=vertical]:hidden">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-[0.1875rem] w-0.75 rounded-full bg-charcoal-600" />
          ))}
        </div>
        {/* Vertical orientation dots (horizontal arrangement) */}
        <div className="relative z-[1] hidden h-0.75 w-5 flex-row items-center justify-center gap-[0.1875rem] bg-background-dimmed transition-opacity group-hover:opacity-0 group-data-[handle-orientation=vertical]:flex">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-0.75 w-[0.1875rem] rounded-full bg-charcoal-600" />
          ))}
        </div>
      </>
    )}
  </PanelResizer>
);

// react-window-splitter drives the collapse animation through @react-spring/rafz,
// which has timing/interaction issues with Firefox that produce visual glitches
// (alternating frames, panels stuck at min, panelHasSpace invariant violations).
// Disable the animation on Firefox; it works correctly in Chromium and Safari.
const RESIZABLE_PANEL_ANIMATION =
  typeof navigator !== "undefined" && /firefox/i.test(navigator.userAgent)
    ? undefined
    : ({ easing: "ease-in-out", duration: 300 } as const);

const COLLAPSIBLE_HANDLE_CLASSNAME = "transition-opacity duration-200";

function collapsibleHandleClassName(show: boolean) {
  return cn(COLLAPSIBLE_HANDLE_CLASSNAME, !show && "pointer-events-none opacity-0");
}

function useFrozenValue<T>(value: T | null | undefined): T | null | undefined {
  const ref = useRef(value);
  if (value != null) ref.current = value;
  return ref.current;
}

export {
  RESIZABLE_PANEL_ANIMATION,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  collapsibleHandleClassName,
  useFrozenValue,
};

export type ResizableSnapshot = React.ComponentProps<typeof PanelGroup>["snapshot"];
