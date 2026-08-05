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
import { startWakePolling } from "./wake-poll";
import { shouldPollWakeFeed, subscribeWatchActivity } from "./watch-activity";
import {
  showWatchWakesSummaryToast,
  showWatchWakeToast,
  WAKE_TOAST_MAX_INDIVIDUAL,
  type WatchWake,
} from "./WatchWakeToast";

const TOASTED_WAKES_STORAGE_KEY = "tdev:dashboard-agent:toasted-wakes";

// Shorter than the poll interval, so a stuck request is dropped before the next tick.
const UNREAD_REQUEST_TIMEOUT_MS = 30_000;

/** `hasAccess` is a UI gate only; the resource routes enforce the same check server-side. */
export function DashboardAgent({
  children,
  hasAccess = false,
  promotedPrompt,
  /** From the page load: unread wakes waiting for this user, whatever this browser remembers. */
  initialUnreadWakes = 0,
}: {
  children: React.ReactNode;
  hasAccess?: boolean;
  promotedPrompt?: SuggestedPrompt;
  initialUnreadWakes?: number;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const actionPath = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/dashboard-agent`;

  const [open, setOpen] = useState(false);
  // Seeded from the page load, so the launcher dot is right before the first poll answers.
  const [unreadWakes, setUnreadWakes] = useState(initialUnreadWakes);
  const toastedWakes = useRef(new Set<string>());
  // The toast source is recent deliveries, not unread, so the dedupe must survive a reload.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(TOASTED_WAKES_STORAGE_KEY);
      if (raw) for (const id of JSON.parse(raw) as string[]) toastedWakes.current.add(id);
    } catch {
      // Storage unavailable; the in-memory dedupe still applies.
    }
  }, []);
  const rememberToasted = useCallback((watchId: string) => {
    toastedWakes.current.add(watchId);
    try {
      // Newest ids only, so the key can't grow unbounded.
      window.localStorage.setItem(
        TOASTED_WAKES_STORAGE_KEY,
        JSON.stringify([...toastedWakes.current].slice(-50))
      );
    } catch {
      // Same as the read.
    }
  }, []);
  // A wake in the on-screen chat toasts but must not light the dot.
  const visibleChat = useRef<string | null>(null);
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
  // `seq` so the same chat can be asked for twice.
  const [openChatRequest, setOpenChatRequest] = useState<
    { chatId: string; seq: number } | undefined
  >(undefined);
  const [watchRequest, setWatchRequest] = useState<{ spec: WatchSpec; seq: number } | undefined>(
    undefined
  );

  const setPanelOpen = useCallback((next: boolean) => {
    setOpen(next);
    // Pending requests must be dropped or a stale one re-applies on the next open.
    if (!next) {
      visibleChat.current = null;
      setFullscreen(false);
      writeAgentFullscreen(false);
      setRequestedMessage(undefined);
      setOpenChatRequest(undefined);
      setWatchRequest(undefined);
    }
  }, []);

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

  // Nothing to be woken about means nothing to poll for. The page load's unread count is the
  // ungated signal; the browser's own memory of a watch starts the poll without a reload. Once
  // either says yes this tab keeps polling, so a wake reaches a tab open before the watch existed.
  const [watching, setWatching] = useState(false);
  useEffect(() => {
    const sync = () => {
      if (
        shouldPollWakeFeed({
          serverUnreadWakes: initialUnreadWakes,
          organizationId: organization.id,
        })
      )
        setWatching(true);
    };
    sync();
    return subscribeWatchActivity(sync);
  }, [organization.id, initialUnreadWakes]);

  useEffect(() => {
    if (!hasAccess || !watching) return;

    let cancelled = false;
    const load = async () => {
      try {
        // Bounded, so one stuck request can't hold the poll's in-flight guard.
        const res = await fetch(`${actionPath}?unread=1`, {
          signal: AbortSignal.timeout(UNREAD_REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { unreadWakes?: number; wakes?: WatchWake[] };
        if (cancelled) return;
        // The wakes list carries read ones too, so only unread ones are subtracted.
        const unreadInView = (data.wakes ?? []).filter(
          (wake) => wake.unread && wake.chatId === visibleChat.current
        ).length;
        setUnreadWakes(Math.max(0, (data.unreadWakes ?? 0) - unreadInView));

        const fresh = (data.wakes ?? []).filter((wake) => !toastedWakes.current.has(wake.watchId));
        for (const wake of fresh) rememberToasted(wake.watchId);

        if (fresh.length > WAKE_TOAST_MAX_INDIVIDUAL) {
          showWatchWakesSummaryToast(fresh.length, () => setPanelOpen(true));
        } else {
          for (const wake of [...fresh].reverse()) {
            showWatchWakeToast(wake, openChat);
          }
        }
      } catch {
        // Try again next tick.
      }
    };

    const stop = startWakePolling({
      load,
      isHidden: () => document.hidden,
      onVisibilityChange: (listener) => {
        document.addEventListener("visibilitychange", listener);
        return () => document.removeEventListener("visibilitychange", listener);
      },
    });

    return () => {
      cancelled = true;
      stop();
    };
  }, [hasAccess, watching, actionPath, setPanelOpen, openChat]);

  // Zeroes the dot right away; the poll restores the truth if another chat has one.
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
        // Catches up on the next open.
      }
    },
    [actionPath]
  );

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
