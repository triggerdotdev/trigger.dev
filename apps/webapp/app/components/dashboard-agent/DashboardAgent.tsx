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

// How often the closed panel asks whether a watch woke a chat.
const UNREAD_POLL_INTERVAL_MS = 60_000;

// Added to each delay so open tabs never settle into polling on the same second.
const UNREAD_POLL_JITTER_MS = 15_000;

/** Wake ids already toasted, across reloads. See the dedupe note in the poll. */
const TOASTED_WAKES_STORAGE_KEY = "tdev:dashboard-agent:toasted-wakes";

/**
 * Mounts the dashboard agent in the env layout. Renders the page content
 * (`children` = the route Outlet) and shares the open/close state via context so
 * the page-header launcher can toggle it. When open, the layout splits into a
 * resizable content + agent panel.
 *
 * `hasAccess` comes from the env layout loader (`canAccessDashboardAgent`); when
 * false the content renders untouched and the context is never exposed, so the
 * launcher stays hidden. The resource routes enforce the same check server-side.
 */
export function DashboardAgent({
  children,
  hasAccess = false,
  promotedPrompt,
}: {
  children: React.ReactNode;
  hasAccess?: boolean;
  // The promoted prompt chip, from the feature flag.
  promotedPrompt?: SuggestedPrompt;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const actionPath = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/dashboard-agent`;

  const [open, setOpen] = useState(false);
  const [unreadWakes, setUnreadWakes] = useState(0);
  // Wakes already toasted, so a wake the user has been shown does not come back
  // every poll while the chat stays unread.
  const toastedWakes = useRef(new Set<string>());
  // The poll's toast source is recent deliveries, not unread, so the dedupe must
  // survive a reload or every wake inside the window re-toasts on every refresh.
  // A failed read (private mode) degrades to the in-memory set.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(TOASTED_WAKES_STORAGE_KEY);
      if (raw) for (const id of JSON.parse(raw) as string[]) toastedWakes.current.add(id);
    } catch {
      // Storage unavailable — session-scoped dedupe still applies.
    }
  }, []);
  const rememberToasted = useCallback((watchId: string) => {
    toastedWakes.current.add(watchId);
    try {
      // Keep the newest ids only, so the key can't grow unbounded. The toast
      // source window is 15 minutes, so a small tail is plenty.
      window.localStorage.setItem(
        TOASTED_WAKES_STORAGE_KEY,
        JSON.stringify([...toastedWakes.current].slice(-50))
      );
    } catch {
      // Same degradation as the read.
    }
  }, []);
  // The chat currently on screen. A wake there streams into the visible
  // transcript, so it toasts but must not light the dot.
  const visibleChat = useRef<string | null>(null);
  // Read lazily so SSR always renders the side panel.
  const [fullscreen, setFullscreen] = useState(readAgentFullscreen);

  const toggleFullscreen = useCallback(() => {
    setFullscreen((current) => {
      writeAgentFullscreen(!current);
      return !current;
    });
  }, []);

  // Navigating to another page drops the takeover back to the side panel, since
  // the user asked for a page. Pathname only: filter and search-param changes stay
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
  // `seq` makes repeat requests with the same text distinct. Bumped by ⌘J while
  // the panel is open; the panel starts a new chat when it changes.
  const [newChatSeq, setNewChatSeq] = useState(0);
  const [requestedMessage, setRequestedMessage] = useState<
    { text: string; seq: number } | undefined
  >(undefined);
  // A specific chat to open, from a wake toast. `seq` so the same chat can be
  // asked for twice (a second wake in a chat the user has already left).
  const [openChatRequest, setOpenChatRequest] = useState<
    { chatId: string; seq: number } | undefined
  >(undefined);
  // A watch card asked for by a `Watch…` entry. A card is not a message, so it
  // travels on its own channel: the panel opens it pre-filled, and nothing reaches
  // the transcript unless the user submits it.
  const [watchRequest, setWatchRequest] = useState<{ spec: WatchSpec; seq: number } | undefined>(
    undefined
  );

  const setPanelOpen = useCallback((next: boolean) => {
    setOpen(next);
    // Closing drops the pending requests: the panel unmounts, so a stale one would
    // re-apply on the next open instead of restoring the last chat.
    if (!next) {
      // No chat is on screen, so the dot counts every unread wake again.
      visibleChat.current = null;
      // Reopening always starts as the side panel, whatever mode it was dismissed
      // in.
      setFullscreen(false);
      writeAgentFullscreen(false);
      setRequestedMessage(undefined);
      setOpenChatRequest(undefined);
      setWatchRequest(undefined);
    }
  }, []);

  // Open the panel on the chat a wake happened in. Without the chat id the panel
  // restores whatever it had open last, which is rarely the one the toast is about.
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

  // The poll behind the dot and the toasts. Runs whether the panel is open or not,
  // since a wake in a chat that isn't on screen still has to announce itself.
  useEffect(() => {
    if (!hasAccess) return;

    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${actionPath}?unread=1`);
        if (!res.ok) return;
        const data = (await res.json()) as { unreadWakes?: number; wakes?: WatchWake[] };
        if (cancelled) return;
        // The wakes list carries read ones too (they still toast once), so only
        // unread ones in the visible chat are subtracted from the dot.
        const unreadInView = (data.wakes ?? []).filter(
          (wake) => wake.unread && wake.chatId === visibleChat.current
        ).length;
        setUnreadWakes(Math.max(0, (data.unreadWakes ?? 0) - unreadInView));

        const fresh = (data.wakes ?? []).filter((wake) => !toastedWakes.current.has(wake.watchId));
        for (const wake of fresh) rememberToasted(wake.watchId);

        // A burst gets one summary toast instead of a wall of persistent ones.
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

    // Self-scheduling rather than setInterval, so each delay carries fresh jitter
    // and tabs that happen to align drift apart again.
    let timer: number | undefined;
    function schedule() {
      timer = window.setTimeout(
        tick,
        UNREAD_POLL_INTERVAL_MS + Math.random() * UNREAD_POLL_JITTER_MS
      );
    }
    async function tick() {
      // A hidden tab has nowhere to show a toast and no visible dot, so it asks
      // nothing. `onVisible` catches it up.
      if (!document.hidden) await load();
      if (!cancelled) schedule();
    }
    // Back in front of the user: refresh immediately and restart the cadence from
    // now, so the catch-up isn't followed by a redundant tick.
    const onVisible = () => {
      if (document.hidden || cancelled) return;
      window.clearTimeout(timer);
      void tick();
    };

    void load();
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [hasAccess, actionPath, setPanelOpen, openChat]);

  // A chat the user is looking at has no unread wakes. Zeroes the dot right away;
  // the poll restores the truth if another chat still has one.
  const markChatRead = useCallback(
    async (chatId: string) => {
      visibleChat.current = chatId;
      setUnreadWakes(0);
      const body = new FormData();
      body.set("intent", "read");
      body.set("chatId", chatId);
      try {
        await fetch(actionPath, { method: "POST", body });
      } catch {
        // The marker catches up the next time the chat is opened.
      }
    },
    [actionPath]
  );

  // ⌘J is contextual: closed opens the panel, open starts a new chat. Closing is
  // Esc or the header button, never ⌘J.
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

  // Entry points that sit above this provider (the side menu item) and the CLI's
  // `?ask=` deep link. See `dashboardAgentOpenRequest.ts`.
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
        // `relative` is the takeover's containing block: in fullscreen the panel is
        // pinned over this box while the split, the page content and the panel stay
        // mounted, so toggling fullscreen is only a class change and the open
        // chat's transport and transcript survive it. See `panel-layout.tsx`.
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
