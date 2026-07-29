import type { SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { DashboardAgentPanel } from "./DashboardAgentPanel";
import { DashboardAgentProvider } from "./dashboardAgentLauncher";
import {
  showWatchWakesSummaryToast,
  showWatchWakeToast,
  WAKE_TOAST_MAX_INDIVIDUAL,
  type WatchWake,
} from "./WatchWakeToast";

// How often the closed panel asks whether a watch woke a chat. A wake is worth
// noticing within a minute, and the count is one indexed query.
const UNREAD_POLL_INTERVAL_MS = 60_000;

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
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const actionPath = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/dashboard-agent`;

  const [open, setOpen] = useState(false);
  const [unreadWakes, setUnreadWakes] = useState(0);
  // Wakes already toasted this session. Session-scoped on purpose: a wake that
  // arrived overnight deserves the toast on the first poll after a reload, but a
  // wake the user has already been shown (and maybe dismissed) must not come
  // back every 60s while the chat stays unread.
  const toastedWakes = useRef(new Set<string>());
  // A request from `openWith`, handed to the panel. `seq` makes repeat requests
  // with the same text distinct, so the panel can tell them apart.
  const [requestedMessage, setRequestedMessage] = useState<
    { text: string; seq: number } | undefined
  >(undefined);
  // A specific chat to open, from a wake toast. `seq` so the same chat can be
  // asked for twice (a second wake in a chat the user has already left).
  const [openChatRequest, setOpenChatRequest] = useState<
    { chatId: string; seq: number } | undefined
  >(undefined);

  // Closing drops any pending request, so reopening the panel later doesn't
  // replay text the user has moved on from.
  const setPanelOpen = useCallback((next: boolean) => {
    setOpen(next);
    // Closing drops both pending requests: the panel unmounts, so a stale one
    // would re-apply on the next open instead of restoring the last chat.
    if (!next) {
      setRequestedMessage(undefined);
      setOpenChatRequest(undefined);
    }
  }, []);

  // Open the panel on the chat a wake happened in. Without the chat id the panel
  // would just restore whatever it had open last, which is rarely the one the
  // toast is about.
  const openChat = useCallback((chatId: string) => {
    setOpen(true);
    setOpenChatRequest((current) => ({ chatId, seq: (current?.seq ?? 0) + 1 }));
  }, []);

  const openWith = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setOpen(true);
    setRequestedMessage((current) => ({ text: trimmed, seq: (current?.seq ?? 0) + 1 }));
  }, []);

  // The dot's poll, and the toast's. Runs only while the panel is CLOSED — an
  // open panel shows the wake in the transcript, so polling then would only race
  // the read marker. Both the interval and the on-close refresh come from this
  // effect re-running on `open`.
  useEffect(() => {
    if (!hasAccess || open) return;

    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${actionPath}?unread=1`);
        if (!res.ok) return;
        const data = (await res.json()) as { unreadWakes?: number; wakes?: WatchWake[] };
        if (cancelled) return;
        setUnreadWakes(data.unreadWakes ?? 0);

        const fresh = (data.wakes ?? []).filter((wake) => !toastedWakes.current.has(wake.watchId));
        for (const wake of fresh) toastedWakes.current.add(wake.watchId);

        // A burst gets one summary toast: a stack of persistent toasts is a wall,
        // not a notification.
        if (fresh.length > WAKE_TOAST_MAX_INDIVIDUAL) {
          showWatchWakesSummaryToast(fresh.length, () => setPanelOpen(true));
        } else {
          // Oldest first, so the newest wake ends up nearest the user.
          for (const wake of [...fresh].reverse()) {
            showWatchWakeToast(wake, openChat);
          }
        }
      } catch {
        // Offline or a hiccup — leave the dot as it is and try again next tick.
      }
    };

    void load();
    const interval = window.setInterval(load, UNREAD_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [hasAccess, open, actionPath, setPanelOpen, openChat]);

  // A chat the user is now looking at has no unread wakes. Zeroes the dot right
  // away (the poll restores the truth on close if another chat still has one) and
  // persists the read marker for the chat that's actually visible.
  const markChatRead = useCallback(
    async (chatId: string) => {
      setUnreadWakes(0);
      const body = new FormData();
      body.set("intent", "read");
      body.set("chatId", chatId);
      try {
        await fetch(actionPath, { method: "POST", body });
      } catch {
        // Not worth surfacing: the marker is caught up the next time the chat is
        // opened.
      }
    },
    [actionPath]
  );

  const context = useMemo(
    () => ({ open, setOpen: setPanelOpen, openWith, unreadWakes }),
    [open, setPanelOpen, openWith, unreadWakes]
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
              openChatRequest={openChatRequest}
              promotedPrompt={promotedPrompt}
              onChatRead={markChatRead}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="h-full min-h-0 overflow-hidden">{children}</div>
      )}
    </DashboardAgentProvider>
  );
}
