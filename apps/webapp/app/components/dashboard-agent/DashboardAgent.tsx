import type { SuggestedPrompt } from "@internal/dashboard-agent-contracts";
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
import { agentDeepLinkParams } from "./ask-ai-channels";
import { createDockedWidthController, type DockedWidthAction } from "./docked-width";
import { DashboardAgentPanel } from "./DashboardAgentPanel";
import { DashboardAgentProvider, TOGGLE_PANEL_SHORTCUT } from "./dashboardAgentLauncher";
import { useDashboardAgentOpenRequests } from "./dashboardAgentOpenRequest";
import type { AgentOpenSource } from "./manual-setup-action";
import type { DraftPrefillParams } from "./alert-creation/flow-state";
import type { EditAlertPrefill } from "~/components/alerts/EditAlertTranscript";
import type { PanelHandle } from "@window-splitter/react";
import {
  AGENT_PANEL_DEFAULT_WIDTH,
  AGENT_PANEL_MAX_WIDTH,
  AGENT_PANEL_MIN_WIDTH,
  agentHiddenContentClassName,
  FloatingAgentWindow,
  initialFloatingRectFor,
  readAgentPanelWidth,
  useAgentPanelMode,
  writeAgentPanelWidth,
} from "./panel-layout";
import { nextPendingTurnChatId } from "./pending-turn";
import { nextVisibleChat } from "./unread-counts";
import { shouldPollUnread, startUnreadPolling } from "./unread-poll";

// Superseded by the account preference; a stray value here would otherwise pin the mode
// forever if this cleanup effect never ran.
const STALE_MODE_STORAGE_KEYS = [
  "tdev:dashboard-agent:mode",
  "tdev:dashboard-agent:fullscreen",
  // The panel group's first autosave key, abandoned with the collapse-driven layout.
  "dashboard-agent-split",
];

// Shorter than the poll interval, so a stuck request is dropped before the next tick.
const UNREAD_REQUEST_TIMEOUT_MS = 30_000;

/** `hasAccess` is a UI gate only; the resource routes enforce the same check server-side. */
export function DashboardAgent({
  children,
  hasAccess = false,
  promotedPrompt,
  initialUnreadWork = 0,
}: {
  children: React.ReactNode;
  hasAccess?: boolean;
  promotedPrompt?: SuggestedPrompt;
  /** Chats whose transcript moved on since their owner last looked. */
  initialUnreadWork?: number;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const user = useUser();
  const modePreference = user.dashboardPreferences.chatOpenMode;
  const actionPath = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/dashboard-agent`;

  const [open, setOpen] = useState(false);
  // Work that finished behind a closed panel. Seeded from the page load, so the launcher dot
  // is right before the first poll answers.
  const [unreadWork, setUnreadWork] = useState(initialUnreadWork);
  // A turn this tab started may finish after the panel closes; that is exactly the case the
  // dot exists for, so the poll has to be running when it lands.
  const [pendingTurnChatId, setPendingTurnChatId] = useState<string | null>(null);
  const handleTurnActivityChange = useCallback((chatId: string, active: boolean) => {
    setPendingTurnChatId((current) => nextPendingTurnChatId(current, { chatId, active }));
  }, []);
  // The chat on screen, read by the poll callback, which outlives the render that started it,
  // so it has to be a ref.
  const visibleChat = useRef<string | null>(null);

  // Switching environment re-runs the layout loader but does not remount it, so the seeds
  // above would keep the old environment's count.
  const seededEnvironment = useRef(environment.id);
  useEffect(() => {
    if (seededEnvironment.current === environment.id) return;
    seededEnvironment.current = environment.id;
    setUnreadWork(initialUnreadWork);
  }, [environment.id, initialUnreadWork]);
  // Every open starts from the account preference; in-chat switches (toggle, drag-to-dock)
  // are transient and never write it back.
  const { mode, changeMode, resetToPreference, revertFullscreen } = useAgentPanelMode(
    modePreference,
    open
  );
  const fullscreen = mode === "fullscreen";
  const docked = mode === "rightPanel";

  // The docked width is ours to restore and to save; the controller owns when either is
  // allowed, because the panel reports a size before this component's mode effect runs.
  const agentPanelHandle = useRef<PanelHandle>(null);
  const dockedWidth = useRef(createDockedWidthController());
  const runDockedWidthAction = useCallback((action: DockedWidthAction) => {
    if (action.type === "apply") agentPanelHandle.current?.setSize(`${action.width}px`);
    if (action.type === "persist") writeAgentPanelWidth(action.width);
  }, []);
  // Storage is read in the effect, never in render: a saved width is not what the server rendered.
  useEffect(() => {
    const controller = dockedWidth.current;
    runDockedWidthAction(
      docked
        ? controller.dock(readAgentPanelWidth(), agentPanelHandle.current?.getPixelSize())
        : controller.undock()
    );
  }, [docked, runDockedWidthAction]);
  // Not gated on `docked`: the panel machine can still hold the callback from the render
  // before the switch, and the controller ignores reports outside a dock anyway.
  const onAgentPanelResize = useCallback(
    ({ pixel }: { pixel: number }) => {
      runDockedWidthAction(dockedWidth.current.resize(pixel));
    },
    [runDockedWidthAction]
  );
  // One write per drag, rather than one per pointer-move frame.
  const onAgentHandleDragEnd = useCallback(() => {
    runDockedWidthAction(dockedWidth.current.dragEnd(agentPanelHandle.current?.getPixelSize()));
  }, [runDockedWidthAction]);

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
  // The contextual entry point a chat was opened from (e.g. the alerts page), read by the
  // header's "Manual setup" action. Cleared on close so it never leaks into the next chat.
  const [openSource, setOpenSource] = useState<AgentOpenSource | undefined>(undefined);
  const [createAlertPrefill, setCreateAlertPrefill] = useState<DraftPrefillParams | undefined>(
    undefined
  );
  const [groupAlertsRequest, setGroupAlertsRequest] = useState<
    { members: { id: string; name: string }[]; seq: number } | undefined
  >();
  const [editAlertRequest, setEditAlertRequest] = useState<
    { prefill: EditAlertPrefill; seq: number } | undefined
  >(undefined);

  // The single entry point for opening the panel — every open route must go through it.
  const openPanel = useCallback(() => {
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
      setOpenSource(undefined);
      setCreateAlertPrefill(undefined);
      setEditAlertRequest(undefined);
      setGroupAlertsRequest(undefined);
    },
    [openPanel, resetToPreference]
  );

  const openWith = useCallback(
    (text: string, options?: { source?: AgentOpenSource }) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      openPanel();
      setEditAlertRequest(undefined);
      setGroupAlertsRequest(undefined);
      setOpenSource(options?.source);
      setRequestedMessage((current) => ({ text: trimmed, seq: (current?.seq ?? 0) + 1 }));
    },
    [openPanel]
  );

  const openCreateAlert = useCallback(
    (prefill: DraftPrefillParams) => {
      openPanel();
      setEditAlertRequest(undefined);
      setGroupAlertsRequest(undefined);
      setOpenSource("alerts");
      setCreateAlertPrefill(prefill);
    },
    [openPanel]
  );

  const openGroupAlerts = useCallback(
    (members: { id: string; name: string }[]) => {
      openPanel();
      setEditAlertRequest(undefined);
      setGroupAlertsRequest((current) => ({ members, seq: (current?.seq ?? 0) + 1 }));
    },
    [openPanel]
  );

  const openEditAlert = useCallback(
    (prefill: EditAlertPrefill) => {
      openPanel();
      setGroupAlertsRequest(undefined);
      setEditAlertRequest((current) => ({ prefill, seq: (current?.seq ?? 0) + 1 }));
    },
    [openPanel]
  );

  // Nothing unread means nothing to poll for. Once polling starts this tab keeps it up.
  const [polling, setPolling] = useState(false);
  if (
    !polling &&
    shouldPollUnread({
      serverUnreadWork: initialUnreadWork,
      turnInFlight: pendingTurnChatId !== null,
    })
  ) {
    setPolling(true);
  }

  useEffect(() => {
    if (!hasAccess || !polling) return;

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
        const data = (await res.json()) as { unreadWork?: number };
        if (cancelled) return;
        setUnreadWork(Math.max(0, data.unreadWork ?? 0));
      } catch {
        // Try again next tick.
      }
    };

    const stop = startUnreadPolling({
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
  }, [hasAccess, polling, actionPath]);

  // The work count is not touched here: the panel derives it from the chat list.
  const markChatRead = useCallback(
    async (chatId: string, options: { leaving: boolean }) => {
      visibleChat.current = nextVisibleChat(chatId, options);
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
        setEditAlertRequest(undefined);
        setGroupAlertsRequest(undefined);
        setNewChatSeq((seq) => seq + 1);
      }
    },
    disabled: !hasAccess,
    enabledOnInputElements: true,
  });

  useDashboardAgentOpenRequests({
    enabled: hasAccess,
    openWith,
    setOpen: setPanelOpen,
    deepLinkParams: agentDeepLinkParams(),
  });

  const context = useMemo(
    () => ({
      open,
      setOpen: setPanelOpen,
      openWith,
      openCreateAlert,
      openEditAlert,
      openGroupAlerts,
      unreadWork,
    }),
    [open, setPanelOpen, openWith, openCreateAlert, openEditAlert, openGroupAlerts, unreadWork]
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
            autosaveId="dashboard-agent-split-v2"
            className="h-full min-h-0"
          >
            <ResizablePanel id="dashboard-content" min="320px">
              <div className={agentHiddenContentClassName(fullscreen)}>{children}</div>
            </ResizablePanel>
            <ResizableHandle
              id="dashboard-agent-handle"
              onDragEnd={onAgentHandleDragEnd}
              size={docked ? "3px" : "0px"}
              className={collapsibleHandleClassName(docked)}
            />
            <ResizablePanel
              id="dashboard-agent-panel"
              handle={agentPanelHandle}
              onResize={onAgentPanelResize}
              // Sized by its constraints, never by the library's collapse state: a collapse
              // lives in the panel machine, which drifts from `mode` and stays shut.
              default={docked ? `${AGENT_PANEL_DEFAULT_WIDTH}px` : "0px"}
              min={docked ? `${AGENT_PANEL_MIN_WIDTH}px` : "0px"}
              max={docked ? `${AGENT_PANEL_MAX_WIDTH}px` : "0px"}
              // Non-rightPanel modes render through position:fixed/absolute, which must
              // escape this panel's own clipping box to avoid being cut to its 0px width.
              // Tailwind v4's important modifier is a trailing `!`, not a leading one.
              className={docked ? undefined : "overflow-visible!"}
            >
              <FloatingAgentWindow
                mode={mode}
                initialRect={initialFloatingRectFor(openSource)}
                onRequestModeChange={changeMode}
              >
                {({ dragHandleProps, dragHandleClassName }) => (
                  <DashboardAgentPanel
                    onClose={() => setPanelOpen(false)}
                    requestedMessage={requestedMessage}
                    openSource={openSource}
                    createAlertPrefill={createAlertPrefill}
                    editAlertRequest={editAlertRequest}
                    groupAlertsRequest={groupAlertsRequest}
                    openChatRequest={openChatRequest}
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
