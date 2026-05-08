"use client";

import React, { useRef } from "react";
import { PanelGroup, Panel, PanelResizer } from "react-window-splitter";
import { cn } from "~/utils/cn";

const ResizablePanelGroup = ({
  className,
  autosaveId,
  snapshot: snapshotProp,
  ...props
}: React.ComponentProps<typeof PanelGroup>) => {
  return (
    <PanelGroup
      className={cn(
        "flex w-full overflow-hidden data-[panel-group-direction=vertical]:flex-col",
        className
      )}
      autosaveId={autosaveId}
      snapshot={getSafeSnapshot(autosaveId, snapshotProp)}
      {...props}
    />
  );
};

// react-window-splitter reads the persisted snapshot from localStorage during
// render and feeds it straight into prepareSnapshot + the state machine. If the
// value is corrupt (extension interference, JSON parse failure) or in a shape
// the library can't safely consume on restore — notably items committed with
// percent-typed currentValues, which trip a `panelHasSpace only works with
// number values` invariant on the next expand — the panel locks at min size
// with no working drag.
//
// We read the snapshot ourselves with try/catch + structural validation. On
// failure we pass `true` (the library's sentinel for "snapshot already
// resolved") so it skips its own localStorage read and falls back to defaults.
// Pure read — safe to call on every render. PanelGroup captures via useState
// on first render, so later calls are wasted work but never wrong.
function getSafeSnapshot(
  autosaveId: string | undefined,
  ssrSnapshot: React.ComponentProps<typeof PanelGroup>["snapshot"]
) {
  if (typeof window === "undefined") return ssrSnapshot;
  if (ssrSnapshot && isValidSnapshot(ssrSnapshot)) return ssrSnapshot;
  if (!autosaveId) return undefined;

  try {
    const raw = window.localStorage.getItem(autosaveId);
    if (!raw) return SNAPSHOT_RESOLVED;
    const parsed: unknown = JSON.parse(raw);
    if (!isValidSnapshot(parsed)) return SNAPSHOT_RESOLVED;
    return parsed as React.ComponentProps<typeof PanelGroup>["snapshot"];
  } catch {
    return SNAPSHOT_RESOLVED;
  }
}

const SNAPSHOT_RESOLVED = true as unknown as React.ComponentProps<typeof PanelGroup>["snapshot"];

function isValidSnapshot(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (!("status" in obj) || !("context" in obj)) return false;
  const ctx = obj.context as Record<string, unknown> | null;
  if (!ctx || typeof ctx !== "object" || !Array.isArray(ctx.items)) return false;

  for (const item of ctx.items) {
    if (!item || typeof item !== "object") return false;
    const it = item as Record<string, unknown>;
    if (it.type !== "panel") continue;
    const cv = it.currentValue as Record<string, unknown> | null;
    if (!cv || typeof cv !== "object" || cv.type !== "pixel") return false;
    // value must be numeric (number or numeric string) so prepareSnapshot's
    // `new Big(value)` rehydration can't throw on us.
    if (typeof cv.value !== "string" && typeof cv.value !== "number") return false;
  }
  return true;
}

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

const RESIZABLE_PANEL_ANIMATION = {
  easing: "ease-in-out" as const,
  duration: 300,
};

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
