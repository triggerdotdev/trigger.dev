import type { SuggestedPrompt, WatchSpec } from "@internal/dashboard-agent-contracts";
import { useLocation } from "@remix-run/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  collapsibleHandleClassName,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { useUser } from "~/hooks/useUser";
import { useAskAiAvailability } from "~/hooks/useAskAiAvailability";
import { agentDeepLinkParams, ASK_AI_SHORTCUT, askAiChannelTarget } from "./ask-ai-channels";
import { DashboardAgentPanel } from "./DashboardAgentPanel";
import { DashboardAgentProvider, TOGGLE_PANEL_SHORTCUT } from "./dashboardAgentLauncher";
import { useDashboardAgentOpenRequests } from "./dashboardAgentOpenRequest";
import {
  agentHiddenContentClassName,
  FloatingAgentWindow,
  useAgentPanelMode,
} from "./panel-layout";
import { nextPendingTurnChatId } from "./pending-turn";
import { nextVisibleChat } from "./unread-counts";
import { createWakePendingCount, startWakePolling, wakesToToast } from "./wake-poll";
import { shouldPollWakeFeed, subscribeWatchActivity } from "./watch-activity";
import {
  dismissWatchWakesSummaryToast,
  showWatchWakesSummaryToast,
  showWatchWakeToast,
  WAKE_TOAST_MAX_INDIVIDUAL,
  type WatchWake,
} from "./WatchWakeToast";

const TOASTED_WAKES_STORAGE_KEY = "tdev:dashboard-agent:toasted-wakes";

// Superseded by the account preference; a stray value here would otherwise pin the mode
// forever if this cleanup effect never ran.
const STALE_MODE_STORAGE_KEYS = ["tdev:dashboard-agent:mode", "tdev:dashboard-agent:fullscreen"];

// Shorter than the poll interval, so a stuck request is dropped before the next tick.
const UNREAD_REQUEST_TIMEOUT_MS = 30_000;

/** `hasAccess` is a UI gate only; the resource routes enforce the same check server-side. */
export function DashboardAgent({
  children,
  hasAccess = false,
  promotedPrompt,
  /** From the page load: unread wakes waiting for this user, whatever this browser remembers. */
  initialUnreadWakes = 0,
  initialUnreadWork = 0,
  /** Also from the page load: a watch is running, so a wake can still arrive in this tab. */
  hasActiveWatches = false,
}: {
  children: React.ReactNode;
  hasAccess?: boolean;
  promotedPrompt?: SuggestedPrompt;
  initialUnreadWakes?: number;
  /** Chats whose transcript moved on since their owner last looked. */
  initialUnreadWork?: number;
  hasActiveWatches?: boolean;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const user = useUser();
  const modePreference = user.dashboardPreferences.chatOpenMode;
  const actionPath = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/dashboard-agent`;

  const [open, setOpen] = useState(false);
  // Seeded from the page load, so the launcher dot is right before the first poll answers.
  const [unreadWakes, setUnreadWakes] = useState(initialUnreadWakes);
  // Work that finished behind a closed panel. Counted server-side on page load and refreshed
  // with the chat list; the wake poll doesn't carry it.
  const [unreadWork, setUnreadWork] = useState(initialUnreadWork);
  // A turn this tab started may finish after the panel closes; that is exactly the case the
  // dot exists for, so the poll has to be running when it lands.
  const [pendingTurnChatId, setPendingTurnChatId] = useState<string | null>(null);
  const handleTurnActivityChange = useCallback((chatId: string, active: boolean) => {
    setPendingTurnChatId((current) => nextPendingTurnChatId(current, { chatId, active }));
  }, []);
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
  // A wake in the on-screen chat toasts but must not light the dot. Read by the poll callback,
  // which outlives the render that started it, so it has to be a ref.
  const visibleChat = useRef<string | null>(null);

  // The count the still-visible grouped toast claims. Consecutive polls add to it so a
  // later batch grows the summary instead of overwriting it with only its own count;
  // reset when the user opens the panel, whichever route they took.
  const wakePending = useRef(createWakePendingCount());

  // Switching environment re-runs the layout loader but does not remount it, so the seeds
  // above would keep the old environment's counts.
  const seededEnvironment = useRef(environment.id);
  useEffect(() => {
    if (seededEnvironment.current === environment.id) return;
    seededEnvironment.current = environment.id;
    setUnreadWakes(initialUnreadWakes);
    setUnreadWork(initialUnreadWork);
  }, [environment.id, initialUnreadWakes, initialUnreadWork]);
  // Every open starts from the account preference; in-chat switches (toggle, drag-to-dock)
  // are transient and never write it back.
  const { mode, changeMode, resetToPreference, revertFullscreen } =
    useAgentPanelMode(modePreference);
  const fullscreen = mode === "fullscreen";

  // Superseded localStorage keys; harmless to skip if storage is unavailable.
  useEffect(() => {
    try {
      for (const key of STALE_MODE_STORAGE_KEYS) window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }, []);

  // Pathname only: filter and search-param changes must keep fullscreen.
  const { pathname } = useLocation();
  const previousPathname = useRef(pathname);
  useEffect(() => {
    if (previousPathname.current === pathname) return;
    previousPathname.current = pathname;
    revertFullscreen();
  }, [pathname, revertFullscreen]);
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

  // The single entry point for opening the panel — every open route must go through it.
  // Opening acknowledges the wakes counted so far, and the visible summary goes with the
  // count it was claiming.
  const openPanel = useCallback(() => {
    wakePending.current.acknowledge();
    dismissWatchWakesSummaryToast();
    setOpen(true);
  }, []);

  const setPanelOpen = useCallback(
    (next: boolean) => {
      if (next) {
        openPanel();
        return;
      }
      setOpen(false);
      // Pending requests must be dropped or a stale one re-applies on the next open.
      visibleChat.current = null;
      // Any transient in-chat mode switch applied only until close; the next open
      // starts from the account preference again.
      resetToPreference();
      setRequestedMessage(undefined);
      setOpenChatRequest(undefined);
      setWatchRequest(undefined);
    },
    [openPanel, resetToPreference]
  );

  const openChat = useCallback(
    (chatId: string) => {
      openPanel();
      setOpenChatRequest((current) => ({ chatId, seq: (current?.seq ?? 0) + 1 }));
    },
    [openPanel]
  );

  const openWith = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      openPanel();
      setRequestedMessage((current) => ({ text: trimmed, seq: (current?.seq ?? 0) + 1 }));
    },
    [openPanel]
  );

  const openWithWatch = useCallback(
    (spec: WatchSpec) => {
      openPanel();
      setWatchRequest((current) => ({ spec, seq: (current?.seq ?? 0) + 1 }));
    },
    [openPanel]
  );

  // Nothing to be woken about means nothing to poll for. The page load's unread count and
  // active-watch flag are the ungated signals; the browser's own memory of a watch starts the
  // poll without a reload. Once any says yes this tab keeps polling, so a wake reaches a tab
  // that was open before the watch existed.
  const [watching, setWatching] = useState(false);
  useEffect(() => {
    const sync = () => {
      if (
        shouldPollWakeFeed({
          serverUnreadWakes: initialUnreadWakes,
          serverHasActiveWatches: hasActiveWatches,
          serverUnreadWork: initialUnreadWork,
          turnInFlight: pendingTurnChatId !== null,
          organizationId: organization.id,
        })
      )
        setWatching(true);
    };
    sync();
    return subscribeWatchActivity(sync);
  }, [organization.id, initialUnreadWakes, hasActiveWatches, initialUnreadWork, pendingTurnChatId]);

  useEffect(() => {
    if (!hasAccess || !watching) return;

    let cancelled = false;
    const load = async () => {
      try {
        // The chat on screen is being read, so the server leaves it out of the work count
        // rather than the client subtracting it back off afterwards.
        const onScreen = visibleChat.current;
        // Bounded, so one stuck request can't hold the poll's in-flight guard.
        const res = await fetch(
          `${actionPath}?unread=1${onScreen ? `&chatId=${encodeURIComponent(onScreen)}` : ""}`,
          { signal: AbortSignal.timeout(UNREAD_REQUEST_TIMEOUT_MS) }
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          unreadWakes?: number;
          unreadWork?: number;
          wakes?: WatchWake[];
        };
        if (cancelled) return;
        // The wakes list carries read ones too, so only unread ones are subtracted.
        const unreadInView = (data.wakes ?? []).filter(
          (wake) => wake.unread && wake.chatId === visibleChat.current
        ).length;
        setUnreadWakes(Math.max(0, (data.unreadWakes ?? 0) - unreadInView));
        setUnreadWork(Math.max(0, data.unreadWork ?? 0));

        const fresh = wakesToToast(data.wakes, toastedWakes.current);
        for (const wake of fresh) rememberToasted(wake.watchId);

        if (fresh.length > 0) {
          const plan = wakePending.current.plan(fresh, WAKE_TOAST_MAX_INDIVIDUAL);
          if (plan.mode === "summary") {
            showWatchWakesSummaryToast(plan.count, () => setPanelOpen(true));
          } else {
            for (const wake of [...plan.wakes].reverse()) {
              showWatchWakeToast(wake, openChat);
            }
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
  }, [hasAccess, watching, actionPath, setPanelOpen, openChat, rememberToasted]);

  // Zeroes the wake dot right away; the poll restores the truth if another chat has one. The
  // work count is not touched here: the panel derives it from the chat list.
  const markChatRead = useCallback(
    async (chatId: string, options: { leaving: boolean }) => {
      visibleChat.current = nextVisibleChat(chatId, options);
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
    () => ({ open, setOpen: setPanelOpen, openWith, openWithWatch, unreadWakes, unreadWork }),
    [open, setPanelOpen, openWith, openWithWatch, unreadWakes, unreadWork]
  );

  if (!hasAccess) {
    return <div className="h-full min-h-0">{children}</div>;
  }

  return (
    <DashboardAgentProvider value={context}>
      {open ? (
        // `relative` is the fullscreen takeover's containing block. The ResizablePanelGroup
        // stays mounted across all three modes — only its sizing/handle degenerate outside
        // rightPanel — so `FloatingAgentWindow` (and the chat panel inside it) sits at the
        // same tree position in every mode and a mode switch never remounts it.
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
              size={mode === "rightPanel" ? "3px" : "0px"}
              className={collapsibleHandleClassName(mode === "rightPanel")}
            />
            <ResizablePanel
              id="dashboard-agent-panel"
              default="380px"
              min="320px"
              max="720px"
              collapsible
              collapsed={mode !== "rightPanel"}
              collapsedSize="0px"
              // Non-rightPanel modes render through position:fixed/absolute, which must
              // escape this panel's own clipping box to avoid being cut to its 0px width.
              // Tailwind v4's important modifier is a trailing `!`, not a leading one.
              className={mode === "rightPanel" ? undefined : "overflow-visible!"}
            >
              <FloatingAgentWindow mode={mode} onRequestModeChange={changeMode}>
                {({ dragHandleProps, dragHandleClassName }) => (
                  <DashboardAgentPanel
                    onClose={() => setPanelOpen(false)}
                    requestedMessage={requestedMessage}
                    openChatRequest={openChatRequest}
                    watchRequest={watchRequest}
                    newChatSeq={newChatSeq}
                    promotedPrompt={promotedPrompt}
                    onChatRead={markChatRead}
                    // The panel's own count, off the chat list it has already marked read.
                    onUnreadWorkChange={setUnreadWork}
                    onTurnActivityChange={handleTurnActivityChange}
                    mode={mode}
                    onModeChange={changeMode}
                    dragHandleProps={dragHandleProps}
                    dragHandleClassName={dragHandleClassName}
                  />
                )}
              </FloatingAgentWindow>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      ) : (
        <div className="h-full min-h-0 overflow-hidden">{children}</div>
      )}
    </DashboardAgentProvider>
  );
}
