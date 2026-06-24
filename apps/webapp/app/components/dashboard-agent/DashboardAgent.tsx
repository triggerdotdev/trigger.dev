import { SparklesIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { DashboardAgentPanel } from "./DashboardAgentPanel";

/**
 * Mounts the dashboard agent in the env layout. Renders the page content
 * (`children` = the route Outlet); when the agent is open it splits the layout
 * into a resizable content + agent panel using the shared Resizable primitive,
 * with `autosaveId` persisting the width. When closed it's a floating launcher.
 *
 * `hasAccess` is resolved server-side in the env layout loader (via
 * `canAccessDashboardAgent`: global env, admins/impersonators, then the
 * global/per-org feature flag, default off), so the launcher is hidden unless
 * the agent is enabled. The resource routes enforce the same check server-side.
 */
export function DashboardAgent({
  children,
  hasAccess = false,
}: {
  children: React.ReactNode;
  hasAccess?: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (!hasAccess) {
    return <div className="h-full min-h-0">{children}</div>;
  }

  if (!open) {
    return (
      <div className="relative h-full min-h-0">
        <div className="h-full overflow-hidden">{children}</div>
        <button
          type="button"
          aria-label="Open the dashboard agent"
          onClick={() => setOpen(true)}
          className="fixed bottom-4 right-4 z-40 flex items-center gap-1.5 rounded-full border border-charcoal-650 bg-background-bright px-3.5 py-2 text-sm text-text-bright shadow-lg transition hover:border-charcoal-550"
        >
          <SparklesIcon className="size-4 text-indigo-500" />
          Ask the agent
        </button>
      </div>
    );
  }

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      autosaveId="dashboard-agent-split"
      className="h-full min-h-0"
    >
      <ResizablePanel id="dashboard-content" min="320px">
        <div className="h-full overflow-hidden">{children}</div>
      </ResizablePanel>
      <ResizableHandle id="dashboard-agent-handle" />
      <ResizablePanel id="dashboard-agent-panel" default="380px" min="320px" max="720px">
        <DashboardAgentPanel onClose={() => setOpen(false)} />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
