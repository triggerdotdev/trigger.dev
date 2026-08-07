import { useState } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { DashboardAgentPanel } from "./DashboardAgentPanel";
import { DashboardAgentProvider } from "./dashboardAgentLauncher";

/**
 * Mounts the dashboard agent in the env layout. Renders the page content
 * (`children` = the route Outlet) and shares the open/close state via context so
 * the page-header launcher (`DashboardAgentLauncher`) can toggle it. When open it
 * splits the layout into a resizable content + agent panel, `autosaveId` persists
 * the width.
 *
 * `hasAccess` is resolved server-side in the env layout loader
 * (`canAccessDashboardAgent`); when false we render the content untouched and
 * never expose the context, so the launcher stays hidden. The resource routes
 * enforce the same check server-side.
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

  return (
    <DashboardAgentProvider value={{ open, setOpen }}>
      {open ? (
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
      ) : (
        <div className="h-full min-h-0 overflow-hidden">{children}</div>
      )}
    </DashboardAgentProvider>
  );
}
