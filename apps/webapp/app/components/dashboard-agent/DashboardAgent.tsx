import type { SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { useLocation } from "@remix-run/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { useAskAiAvailability } from "~/hooks/useAskAiAvailability";
import { agentDeepLinkParams, ASK_AI_SHORTCUT, askAiChannelTarget } from "./ask-ai-channels";
import { DashboardAgentPanel } from "./DashboardAgentPanel";
import { DashboardAgentProvider, TOGGLE_PANEL_SHORTCUT } from "./dashboardAgentLauncher";
import { useDashboardAgentOpenRequests } from "./dashboardAgentOpenRequest";
import {
  agentHiddenContentClassName,
  agentTakeoverClassName,
  readAgentFullscreen,
  writeAgentFullscreen,
} from "./panel-layout";

/** `hasAccess` is a UI gate only; the resource routes enforce the same check server-side. */
export function DashboardAgent({
  children,
  hasAccess = false,
  promotedPrompt,
}: {
  children: React.ReactNode;
  hasAccess?: boolean;
  promotedPrompt?: SuggestedPrompt;
}) {
  const [open, setOpen] = useState(false);
  // Read lazily so SSR always renders the side panel.
  const [fullscreen, setFullscreen] = useState(readAgentFullscreen);

  const toggleFullscreen = useCallback(() => {
    setFullscreen((current) => {
      writeAgentFullscreen(!current);
      return !current;
    });
  }, []);

  // Pathname only: filter and search-param changes must keep fullscreen.
  const { pathname } = useLocation();
  const previousPathname = useRef(pathname);
  useEffect(() => {
    if (previousPathname.current === pathname) return;
    previousPathname.current = pathname;
    setFullscreen((current) => {
      if (current) writeAgentFullscreen(false);
      return false;
    });
  }, [pathname]);
  const [newChatSeq, setNewChatSeq] = useState(0);
  const [requestedMessage, setRequestedMessage] = useState<
    { text: string; seq: number } | undefined
  >(undefined);

  const setPanelOpen = useCallback((next: boolean) => {
    setOpen(next);
    // Pending requests must be dropped or a stale one re-applies on the next open.
    if (!next) {
      setFullscreen(false);
      writeAgentFullscreen(false);
      setRequestedMessage(undefined);
    }
  }, []);

  const openWith = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setOpen(true);
    setRequestedMessage((current) => ({ text: trimmed, seq: (current?.seq ?? 0) + 1 }));
  }, []);

  // ⌘J is contextual: closed opens the panel, open starts a new chat. It never closes.
  useShortcutKeys({
    shortcut: TOGGLE_PANEL_SHORTCUT,
    action: () => {
      if (!open) {
        setPanelOpen(true);
      } else {
        setNewChatSeq((seq) => seq + 1);
      }
    },
    disabled: !hasAccess,
    enabledOnInputElements: true,
  });

  // ⌘I and the CLI's `?aiHelp=` link are Ask AI's; the agent only answers them where Ask AI
  // cannot open.
  const askAi = useAskAiAvailability();
  const ownsAskAiChannels = askAiChannelTarget(askAi) === "dashboard-agent";

  useShortcutKeys({
    shortcut: ASK_AI_SHORTCUT,
    action: () => setPanelOpen(true),
    disabled: !hasAccess || !ownsAskAiChannels,
    enabledOnInputElements: true,
  });

  useDashboardAgentOpenRequests({
    enabled: hasAccess,
    openWith,
    setOpen: setPanelOpen,
    deepLinkParams: agentDeepLinkParams(askAi),
  });

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
        // `relative` is the takeover's containing block.
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
                  newChatSeq={newChatSeq}
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
