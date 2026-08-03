import type { SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { useCallback, useMemo, useState } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { DashboardAgentPanel } from "./DashboardAgentPanel";
import { DashboardAgentProvider, TOGGLE_PANEL_SHORTCUT } from "./dashboardAgentLauncher";
import { useDashboardAgentOpenRequests } from "./dashboardAgentOpenRequest";
import {
  agentHiddenContentClassName,
  agentTakeoverClassName,
  readAgentFullscreen,
  writeAgentFullscreen,
} from "./panel-layout";

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
  // The side panel is the default; someone who last worked fullscreen gets
  // fullscreen back. Read lazily so SSR always renders the side panel.
  const [fullscreen, setFullscreen] = useState(readAgentFullscreen);

  const toggleFullscreen = useCallback(() => {
    setFullscreen((current) => {
      writeAgentFullscreen(!current);
      return !current;
    });
  }, []);
  // A request from `openWith`, handed to the panel. `seq` makes repeat requests
  // with the same text distinct, so the panel can tell them apart.
  const [requestedMessage, setRequestedMessage] = useState<
    { text: string; seq: number } | undefined
  >(undefined);

  // Closing drops any pending request, so reopening the panel later doesn't
  // replay text the user has moved on from.
  const setPanelOpen = useCallback((next: boolean) => {
    setOpen(next);
    // The panel unmounts on close, so a stale request would re-apply on the next
    // open instead of restoring the last chat.
    if (!next) setRequestedMessage(undefined);
  }, []);

  const openWith = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setOpen(true);
    setRequestedMessage((current) => ({ text: trimmed, seq: (current?.seq ?? 0) + 1 }));
  }, []);

  // ⌘J toggles the panel. Opening mounts the composer, which focuses itself, so
  // the shortcut lands you in the text field. Enabled inside inputs too, so the
  // same keystroke closes the panel while you're typing in it.
  useShortcutKeys({
    shortcut: TOGGLE_PANEL_SHORTCUT,
    action: () => setPanelOpen(!open),
    disabled: !hasAccess,
    enabledOnInputElements: true,
  });

  // Entry points that sit ABOVE this provider — the side menu's "Ask {agent}"
  // item — and the CLI's `?ask=` deep link, both handled in one place. See
  // `dashboardAgentOpenRequest.ts`.
  useDashboardAgentOpenRequests({ enabled: hasAccess, openWith, setOpen: setPanelOpen });

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
        // `relative` is the takeover's containing block: in fullscreen the panel
        // is pinned over this box — everything right of the side nav — while the
        // split, the page content and the panel itself all stay mounted. Toggling
        // fullscreen is a class change, nothing more, so the open chat's
        // transport and transcript survive it. See `panel-layout.tsx`.
        <div className="relative h-full min-h-0">
          <ResizablePanelGroup
            orientation="horizontal"
            autosaveId="dashboard-agent-split"
            className="h-full min-h-0"
          >
            <ResizablePanel id="dashboard-content" min="320px">
              <div className={agentHiddenContentClassName(fullscreen)}>{children}</div>
            </ResizablePanel>
            <ResizableHandle
              id="dashboard-agent-handle"
              className={fullscreen ? "invisible" : undefined}
            />
            <ResizablePanel id="dashboard-agent-panel" default="380px" min="320px" max="720px">
              <div className={agentTakeoverClassName(fullscreen)}>
                <DashboardAgentPanel
                  onClose={() => setPanelOpen(false)}
                  requestedMessage={requestedMessage}
                  promotedPrompt={promotedPrompt}
                  isFullscreen={fullscreen}
                  onToggleFullscreen={toggleFullscreen}
                />
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      ) : (
        <div className="h-full min-h-0 overflow-hidden">{children}</div>
      )}
    </DashboardAgentProvider>
  );
}
