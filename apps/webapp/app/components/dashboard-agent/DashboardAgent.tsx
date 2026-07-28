import type { SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { useCallback, useMemo, useState } from "react";
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
  promotedPrompt,
}: {
  children: React.ReactNode;
  hasAccess?: boolean;
  // The product-controlled promoted prompt chip, from the feature flag.
  promotedPrompt?: SuggestedPrompt;
}) {
  const [open, setOpen] = useState(false);
  // A request from `openWith`, handed to the panel. `seq` makes repeat requests
  // with the same text distinct, so the panel can tell them apart.
  const [requestedMessage, setRequestedMessage] = useState<
    { text: string; seq: number } | undefined
  >(undefined);

  // Closing drops any pending request, so reopening the panel later doesn't
  // replay text the user has moved on from.
  const setPanelOpen = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) setRequestedMessage(undefined);
  }, []);

  const openWith = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setOpen(true);
    setRequestedMessage((current) => ({ text: trimmed, seq: (current?.seq ?? 0) + 1 }));
  }, []);

  const context = useMemo(
    () => ({ open, setOpen: setPanelOpen, openWith }),
    [open, setPanelOpen, openWith]
  );

  if (!hasAccess) {
    return <div className="h-full min-h-0">{children}</div>;
  }

  return (
    <DashboardAgentProvider value={context}>
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
            <DashboardAgentPanel
              onClose={() => setPanelOpen(false)}
              requestedMessage={requestedMessage}
              promotedPrompt={promotedPrompt}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="h-full min-h-0 overflow-hidden">{children}</div>
      )}
    </DashboardAgentProvider>
  );
}
