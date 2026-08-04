import type { SuggestedPrompt, WatchSpec } from "@internal/dashboard-agent-contracts";
import { useLocation } from "@remix-run/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
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
  // The side panel is the default; someone who last worked fullscreen gets
  // fullscreen back. Read lazily so SSR always renders the side panel.
  const [fullscreen, setFullscreen] = useState(readAgentFullscreen);

  const toggleFullscreen = useCallback(() => {
    setFullscreen((current) => {
      writeAgentFullscreen(!current);
      return !current;
    });
  }, []);

  // Navigating to another page drops the takeover back to the side panel: the
  // user asked for a page (a navbar click, an agent navigation), so the page
  // must be what they see. Pathname only — filter and search-param changes stay
  // on the page and keep fullscreen.
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
  // A request from `openWith`, handed to the panel. `seq` makes repeat requests
  // with the same text distinct, so the panel can tell them apart.
  // Bumped by contextual ⌘J while the panel is open; the panel starts a new
  // chat when it changes.
  const [newChatSeq, setNewChatSeq] = useState(0);
  const [requestedMessage, setRequestedMessage] = useState<
    { text: string; seq: number } | undefined
  >(undefined);
  // A specific chat to open, from a wake toast. `seq` so the same chat can be
  // asked for twice (a second wake in a chat the user has already left).
  const [openChatRequest, setOpenChatRequest] = useState<
    { chatId: string; seq: number } | undefined
  >(undefined);
  // A watch card asked for by a `Watch…` entry (§2.1). A card is not a message,
  // so it travels on its own channel: the panel opens it pre-filled, and nothing
  // reaches the transcript unless the user submits it.
  const [watchRequest, setWatchRequest] = useState<{ spec: WatchSpec; seq: number } | undefined>(
    undefined
  );

  // Closing drops any pending request, so reopening the panel later doesn't
  // replay text the user has moved on from.
  const setPanelOpen = useCallback((next: boolean) => {
    setOpen(next);
    // Closing drops both pending requests: the panel unmounts, so a stale one
    // would re-apply on the next open instead of restoring the last chat.
    if (!next) {
      setRequestedMessage(undefined);
      setOpenChatRequest(undefined);
      // An abandoned card leaves no trace (§2.2) — including no pending request
      // that would re-open it the next time the panel is.
      setWatchRequest(undefined);
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

  const openWithWatch = useCallback((spec: WatchSpec) => {
    setOpen(true);
    setWatchRequest((current) => ({ spec, seq: (current?.seq ?? 0) + 1 }));
  }, []);

  // The dot's poll, and the toast's. Runs whether the panel is open or not: a
  // wake in a chat that isn't on screen (another chat open, or none) must
  // announce itself either way. `toastedWakes` keeps a wake that streamed into
  // the visible transcript from toasting twice across polls.
  useEffect(() => {
    if (!hasAccess) return;

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
  }, [hasAccess, actionPath, setPanelOpen, openChat]);

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

  // ⌘J is contextual: closed → open the panel (the composer focuses itself, so
  // the keystroke lands you in the text field); open → start a new chat.
  // Closing is Esc or the header's ×, never ⌘J.
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

  // Entry points that sit ABOVE this provider — the side menu's "Ask {agent}"
  // item — and the CLI's `?ask=` deep link, both handled in one place. See
  // `dashboardAgentOpenRequest.ts`.
  useDashboardAgentOpenRequests({ enabled: hasAccess, openWith, setOpen: setPanelOpen });

  const context = useMemo(
    () => ({ open, setOpen: setPanelOpen, openWith, openWithWatch, unreadWakes }),
    [open, setPanelOpen, openWith, openWithWatch, unreadWakes]
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
                  openChatRequest={openChatRequest}
                  watchRequest={watchRequest}
                  newChatSeq={newChatSeq}
                  promotedPrompt={promotedPrompt}
                  onChatRead={markChatRead}
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
