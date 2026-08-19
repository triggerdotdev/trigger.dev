import type { UIMessage } from "@ai-sdk/react";
import { useLocation } from "@remix-run/react";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AgentSpinner } from "~/components/primitives/Spinner";
import { useToast } from "~/components/primitives/Toast";
import { useAgentPageContext } from "~/hooks/useAgentPageContext";
import { useApiOrigin } from "~/hooks/useApiOrigin";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import {
  DashboardAgentChat,
  type DashboardAgentClientData,
  type DashboardAgentSession,
} from "./DashboardAgentChat";
import { createCoalescedReload } from "./coalesced-reload";
import {
  forgetLastChat,
  lastChatStorageKey,
  readLastChat,
  shouldPersistLastChat,
  writeLastChat,
} from "./last-chat-storage";
import { DashboardAgentDraft } from "./DashboardAgentDraft";
import {
  parseQuotaReachedResponse,
  shouldClearCapReached,
  type MessageQuota,
} from "./message-quota";
import { WatchCard } from "./WatchCard";
import { watchDraftFor } from "./watch-card";
import { NO_WATCH_CARD, watchCardReducer } from "./watch-card-state";
import { forgetWatchActivity, rememberWatchActivity } from "./watch-activity";
import type { TurnActivity } from "./DashboardAgentMessages";
import { DashboardAgentHeader } from "./DashboardAgentHeader";
import type { DashboardAgentChat as DashboardAgentChatListItem } from "./DashboardAgentHistory";
import type { SuggestedPrompt, WatchSpec } from "@internal/dashboard-agent-contracts";
import { resolveOpenedChat, type OpenedChatResponse } from "./opened-chat";
import type { AgentPageContext } from "./page-context-types";
import { agentPageLabel } from "./page-label";
import { explicitPromptTarget } from "./explicit-prompt";
import { escapeClosesPanel } from "./panel-escape";
import {
  markChatListRead,
  nextVisibleChat,
  settleReadChats,
  unreadWorkCount,
} from "./unread-counts";
import { AgentPanelColumn } from "./panel-layout";
import { markerAfterActiveChat, markerAfterActivity } from "./thinking-marker";
import { concurrencyPath } from "~/utils/pathBuilder";

function serializePageContext(pageContext: AgentPageContext): string | undefined {
  try {
    return JSON.stringify(pageContext);
  } catch {
    return undefined;
  }
}

type ActiveChat = {
  chatId: string;
  // The org the chat belongs to, so a switch can't file it under the new org's key.
  organizationId: string;
  messages: UIMessage[];
  session: DashboardAgentSession | null;
  pendingFirstMessage?: string;
  // Head start: the turn is already in flight, so the session hydrates as streaming.
  streaming?: boolean;
};

// The server generates the chat id on the first send; the client never invents one.
export function DashboardAgentPanel({
  onClose,
  requestedMessage,
  openChatRequest,
  newChatSeq,
  promotedPrompt,
  watchRequest,
  onChatRead,
  onUnreadWorkChange,
  onTurnActivityChange,
  isFullscreen = false,
  onToggleFullscreen,
}: {
  onClose: () => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  // Every `seq` below distinguishes repeat requests with identical contents.
  requestedMessage?: { text: string; seq: number };
  openChatRequest?: { chatId: string; seq: number };
  newChatSeq?: number;
  promotedPrompt?: SuggestedPrompt;
  watchRequest?: { spec: WatchSpec; seq: number };
  onChatRead?: (chatId: string, options: { leaving: boolean }) => void;
  /** How many chats still hold work their owner hasn't seen. */
  onUnreadWorkChange?: (count: number) => void;
  /** Whether a turn is running in a chat, so a closed panel still knows to expect an answer. */
  onTurnActivityChange?: (chatId: string, active: boolean) => void;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const user = useUser();
  const apiOrigin = useApiOrigin();
  const location = useLocation();
  const pageContext = useAgentPageContext();
  const toast = useToast();

  const actionPath = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/dashboard-agent`;
  const storageKey = lastChatStorageKey(organization.id);

  const panelRef = useRef<HTMLDivElement | null>(null);
  // Declared before the chat plumbing: changing chat dispatches into it.
  const [watchCard, dispatchWatchCard] = useReducer(watchCardReducer, NO_WATCH_CARD);
  const [chats, setChats] = useState<DashboardAgentChatListItem[]>([]);
  // Until the list has arrived, the page load's server count is the better answer.
  const [chatsLoaded, setChatsLoaded] = useState(false);
  const [active, setActive] = useState<ActiveChat | null>(null);
  // A refused `create` over the cap: the draft shows the upgrade block instead of a raw toast.
  const [capReached, setCapReached] = useState<{ limit: number; planResolved: boolean } | null>(
    null
  );
  // Starts true so an `openWith` request waits for the restore instead of racing it.
  const [loading, setLoading] = useState(
    () => readLastChat(storageKey)?.path === location.pathname
  );

  const currentPage = agentPageLabel(pageContext, location.pathname);

  const pagePaths = useMemo<Record<string, string>>(
    () => ({ raise_env_limit: concurrencyPath(organization, project, environment) }),
    [organization, project, environment]
  );

  // A fresh object every render, so the clientData memo keys off the serialized form.
  const pageContextKey = serializePageContext(pageContext);

  const clientData = useMemo<DashboardAgentClientData>(
    () => ({
      userId: user.id,
      organizationId: organization.id,
      projectId: project.id,
      environmentId: environment.id,
      currentPage: location.pathname,
      pageContext: pageContextKey ? (JSON.parse(pageContextKey) as AgentPageContext) : undefined,
    }),
    [user.id, organization.id, project.id, environment.id, location.pathname, pageContextKey]
  );

  const [thinkingChatId, setThinkingChatId] = useState<string | null>(null);
  const handleActivityChange = useCallback(
    (chatId: string, activity: TurnActivity | null) => {
      setThinkingChatId((previous) => markerAfterActivity(previous, chatId, activity));
      onTurnActivityChange?.(chatId, activity !== null);
    },
    [onTurnActivityChange]
  );

  // The read POST and its reload can land out of order, so mask the next list.
  const justRead = useRef<Set<string>>(new Set());

  // Read when the response lands, not when it was requested, so a chat switched to mid-flight
  // is the one the list settles against.
  const visibleChatId = useRef<string | null>(null);

  // Ordering-safe: if the new chat has not reported yet, its own report re-sets the marker.
  useEffect(() => {
    setThinkingChatId((previous) => markerAfterActiveChat(previous, active?.chatId));
  }, [active?.chatId]);

  const loadHistory = useMemo(
    () =>
      createCoalescedReload(async () => {
        try {
          const res = await fetch(actionPath);
          if (!res.ok) throw new Error(`History request failed (${res.status})`);
          const data = (await res.json()) as { chats?: DashboardAgentChatListItem[] };
          const read = justRead.current;
          justRead.current = new Set();
          const chats = data.chats ?? [];
          // Reloaded after every turn and after a watch is created, so this is where the browser
          // learns whether the wake feed is worth polling.
          const pending = chats.some((chat) => chat.hasActiveWatch || chat.hasUnreadWake);
          if (pending) rememberWatchActivity(organization.id);
          else forgetWatchActivity(organization.id);
          const settled = settleReadChats(chats, read, visibleChatId.current);
          setChats(settled);
          setChatsLoaded(true);
        } catch (error) {
          console.error("Dashboard agent: failed to load chat history", error);
          toast.error("We couldn't load your previous chats. Try again in a moment.");
        }
      }),
    [actionPath, organization.id, toast]
  );

  // Bumped on each open so a slower earlier open can't overwrite a newer one.
  const openChatRequestSeq = useRef(0);

  // Bound to its chat, which remounts with a fresh guard ref on every switch.
  const [sendRequest, setSendRequest] = useState<
    { text: string; seq: number; chatId: string } | undefined
  >(undefined);

  // The one way the panel changes chat: it invalidates any in-flight open and abandons a
  // half-configured watch card, which would otherwise be submitted against the new chat.
  const claimChatSlot = useCallback(() => {
    dispatchWatchCard({ type: "chat-changed" });
    // A new attempt goes back to the server, which re-refuses if the cap still stands.
    setCapReached(null);
    // A request belongs to the chat it was made in: the remounting chat has a fresh guard ref,
    // so a kept request would be sent a second time.
    setSendRequest(undefined);
    return ++openChatRequestSeq.current;
  }, []);

  const openChat = useCallback(
    async (id: string) => {
      const seq = claimChatSlot();
      setLoading(true);
      try {
        const res = await fetch(`${actionPath}?chatId=${encodeURIComponent(id)}`);
        if (!res.ok && res.status !== 404) {
          console.error(`Dashboard agent: failed to open chat ${id} (${res.status})`);
          toast.error("We couldn't open that chat. Try again in a moment.");
          // Transient failure: keep the stored pointer so the chat can be reopened.
          if (seq === openChatRequestSeq.current) setActive(null);
          return;
        }
        const data = res.ok ? ((await res.json()) as OpenedChatResponse) : undefined;
        if (seq !== openChatRequestSeq.current) return;
        const opened = resolveOpenedChat(id, data);
        if (opened.kind === "gone") {
          // Deleted, or another org's: drop the pointer so it can't be restored again.
          setActive(null);
          forgetLastChat(storageKey);
          return;
        }
        setActive({ ...opened, organizationId: organization.id });
      } catch (error) {
        console.error(`Dashboard agent: failed to open chat ${id}`, error);
        toast.error("We couldn't open that chat. Try again in a moment.");
        if (seq === openChatRequestSeq.current) setActive(null);
      } finally {
        if (seq === openChatRequestSeq.current) setLoading(false);
      }
    },
    [actionPath, claimChatSlot, organization.id, storageKey, toast]
  );

  const createChat = useCallback(
    async (text: string) => {
      const seq = claimChatSlot();
      setLoading(true);
      try {
        const userMessage: UIMessage = {
          id: generateFriendlyId("msg"),
          role: "user",
          parts: [{ type: "text", text }],
        };
        const body = new FormData();
        body.set("intent", "create");
        body.set("message", JSON.stringify(userMessage));
        body.set("clientData", JSON.stringify(clientData));
        const res = await fetch(actionPath, { method: "POST", body });
        const data = (await res.json()) as {
          chatId?: string;
          publicAccessToken?: string;
          headStarted?: boolean;
          error?: string;
          limit?: number;
        };
        if (seq !== openChatRequestSeq.current) return;
        if (!res.ok || !data.chatId || !data.publicAccessToken) {
          const reached = parseQuotaReachedResponse(res.status, data);
          if (reached) {
            setCapReached(reached);
            setActive(null);
            return;
          }
          console.error(`Dashboard agent: failed to create chat (${res.status})`, data.error);
          toast.error(data.error ?? "We couldn't start that chat. Try again in a moment.");
          setActive(null);
          return;
        }
        setCapReached(null);
        setActive({
          chatId: data.chatId,
          organizationId: organization.id,
          messages: data.headStarted ? [userMessage] : [],
          session: { publicAccessToken: data.publicAccessToken },
          pendingFirstMessage: data.headStarted ? undefined : text,
          streaming: data.headStarted,
        });
      } catch (error) {
        console.error("Dashboard agent: failed to create chat", error);
        toast.error("We couldn't start that chat. Try again in a moment.");
        if (seq === openChatRequestSeq.current) setActive(null);
      } finally {
        if (seq === openChatRequestSeq.current) setLoading(false);
      }
    },
    [actionPath, claimChatSlot, clientData, organization.id, toast]
  );

  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    void loadHistory();
    const stored = readLastChat(storageKey);
    if (stored && stored.path === location.pathname) {
      void openChat(stored.chatId);
    } else {
      setLoading(false);
    }
    // location is deliberately not a dep: this is a mount-time decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openChat, storageKey, loadHistory]);

  // Crossing into another org does not remount the layout.
  const panelOrg = useRef(organization.id);
  useEffect(() => {
    if (panelOrg.current === organization.id) return;
    panelOrg.current = organization.id;
    claimChatSlot();
    setActive(null);
    setCapReached(null);
    setLoading(false);
    setChats([]);
    setChatsLoaded(false);
    void loadHistory();
  }, [organization.id, claimChatSlot, loadHistory]);

  const handledOpenChatSeq = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!openChatRequest || handledOpenChatSeq.current === openChatRequest.seq) return;
    handledOpenChatSeq.current = openChatRequest.seq;
    // Reloading the visible transcript would drop a turn in flight.
    if (openChatRequest.chatId === active?.chatId) return;
    void openChat(openChatRequest.chatId);
    // `active` is read, not tracked: a later change must not re-run the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openChatRequest, openChat]);

  useEffect(() => {
    if (!shouldPersistLastChat(active, organization.id)) return;
    writeLastChat(storageKey, { chatId: active.chatId, path: location.pathname });
  }, [active, organization.id, storageKey, location.pathname]);

  useEffect(() => {
    if (!active?.chatId) return;
    const chatId = active.chatId;
    onChatRead?.(chatId, { leaving: false });
    visibleChatId.current = nextVisibleChat(chatId, { leaving: false });
    justRead.current.add(chatId);
    setChats((previous) => markChatListRead(previous, chatId));
    // Read again on the way out: a wake can land while the chat is open.
    return () => {
      onChatRead?.(chatId, { leaving: true });
      visibleChatId.current = nextVisibleChat(chatId, { leaving: true });
      justRead.current.add(chatId);
      setChats((previous) => markChatListRead(previous, chatId));
    };
  }, [active?.chatId, onChatRead]);

  // The one source for the dot's work count: nudging it per open double-subtracts.
  useEffect(() => {
    if (!chatsLoaded) return;
    onUnreadWorkChange?.(unreadWorkCount(chats, active?.chatId));
  }, [chats, chatsLoaded, active?.chatId, onUnreadWorkChange]);

  const handledRequestSeq = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!requestedMessage || handledRequestSeq.current === requestedMessage.seq) return;
    const target = explicitPromptTarget({
      chat: loading ? "opening" : active ? "open" : "none",
      turnInFlight: thinkingChatId !== null && thinkingChatId === active?.chatId,
    });
    // Held requests are re-asked by this same effect once the panel settles.
    if (target === "hold") return;
    handledRequestSeq.current = requestedMessage.seq;
    if (target === "new-chat") {
      void createChat(requestedMessage.text);
      return;
    }
    setSendRequest({ ...requestedMessage, chatId: active!.chatId });
  }, [requestedMessage, loading, active, thinkingChatId, createChat]);

  // Carries its chat id so a later-mounted chat cannot adopt another chat's block.
  const [appendedMessages, setAppendedMessages] = useState<
    { chatId: string; messages: UIMessage[]; seq: number } | undefined
  >(undefined);

  const handledWatchSeq = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!watchRequest || handledWatchSeq.current === watchRequest.seq) return;
    handledWatchSeq.current = watchRequest.seq;
    dispatchWatchCard({
      type: "open",
      draft: watchDraftFor(watchRequest.spec),
      requestId: generateFriendlyId("wreq"),
    });
  }, [watchRequest]);

  // Nothing is posted or persisted until the card is submitted.
  const openWatchCard = useCallback((spec: WatchSpec) => {
    dispatchWatchCard({
      type: "open",
      draft: watchDraftFor(spec),
      requestId: generateFriendlyId("wreq"),
    });
  }, []);

  const dismissWatchCard = () => dispatchWatchCard({ type: "dismissed" });

  const submitWatch = useCallback(async () => {
    const draft = watchCard.draft;
    if (!draft) return;
    // Held across retries, so a resubmit repairs the same pair of records.
    const clientRequestId = watchCard.requestId ?? generateFriendlyId("wreq");
    dispatchWatchCard({ type: "submitting", requestId: clientRequestId });
    try {
      const body = new FormData();
      body.set("intent", "watch-create");
      body.set("draft", JSON.stringify(draft));
      body.set("clientRequestId", clientRequestId);
      // A watch is chat-bound: with no chat open the server creates one.
      if (active?.chatId) body.set("chatId", active.chatId);

      const res = await fetch(actionPath, { method: "POST", body });
      const data = (await res.json()) as {
        chatId?: string;
        messages?: UIMessage[];
        error?: string;
      };
      if (!res.ok || !data.chatId || !data.messages) {
        dispatchWatchCard({
          type: "failed",
          error: data.error ?? "We couldn't start that watch. Try again in a moment.",
        });
        return;
      }

      const messages = data.messages;
      if (active?.chatId === data.chatId) {
        setAppendedMessages((current) => ({
          chatId: data.chatId!,
          messages,
          seq: (current?.seq ?? 0) + 1,
        }));
        dispatchWatchCard({ type: "submitted" });
      } else {
        claimChatSlot();
        // No session: nothing is streaming and the records are the whole chat.
        setActive({
          chatId: data.chatId,
          messages,
          session: null,
          organizationId: organization.id,
        });
      }
      void loadHistory();
    } catch (error) {
      console.error("Dashboard agent: failed to create watch", error);
      dispatchWatchCard({
        type: "failed",
        error: "We couldn't start that watch. Try again in a moment.",
      });
    }
  }, [
    watchCard.draft,
    watchCard.requestId,
    active?.chatId,
    actionPath,
    claimChatSlot,
    loadHistory,
  ]);

  const watchCardElement = watchCard.draft ? (
    <WatchCard
      draft={watchCard.draft}
      onChange={(draft) => dispatchWatchCard({ type: "edit", draft })}
      onSubmit={() => void submitWatch()}
      onCancel={dismissWatchCard}
      pending={watchCard.pending}
      error={watchCard.error}
    />
  ) : null;

  const newChat = useCallback(() => {
    claimChatSlot();
    setLoading(false);
    setActive(null);
  }, [claimChatSlot]);

  // Released only by a read that proves capacity: an unknown quota keeps the block.
  const handleQuotaChange = useCallback((quota: MessageQuota) => {
    if (shouldClearCapReached(quota)) setCapReached(null);
  }, []);

  const switchChat = useCallback(
    (id: string) => {
      void openChat(id);
    },
    [openChat]
  );

  // The ref skips the mount-time value so opening the panel never resets a restored chat.
  const seenNewChatSeq = useRef(newChatSeq ?? 0);
  useEffect(() => {
    if (newChatSeq === undefined || newChatSeq === seenNewChatSeq.current) return;
    seenNewChatSeq.current = newChatSeq;
    newChat();
  }, [newChatSeq, newChat]);

  const deleteChat = useCallback(
    async (id: string) => {
      const body = new FormData();
      body.set("intent", "delete");
      body.set("chatId", id);
      try {
        const res = await fetch(actionPath, { method: "POST", body });
        if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      } catch (error) {
        console.error("Dashboard agent: failed to delete chat", error);
        toast.error("We couldn't delete that chat. Try again in a moment.");
        return;
      }
      setThinkingChatId((previous) => (previous === id ? null : previous));
      if (id === active?.chatId) newChat();
      void loadHistory();
    },
    [actionPath, active?.chatId, newChat, loadHistory, toast]
  );

  const cancelWatch = useCallback(
    async (watchId: string) => {
      const chatId = active?.chatId;
      if (!chatId) return;
      setChats((previous) =>
        previous.map((chat) =>
          chat.id === chatId
            ? { ...chat, watches: (chat.watches ?? []).filter((watch) => watch.id !== watchId) }
            : chat
        )
      );
      const body = new FormData();
      body.set("intent", "watch-cancel");
      body.set("chatId", chatId);
      body.set("watchId", watchId);
      try {
        const res = await fetch(actionPath, { method: "POST", body });
        if (!res.ok) throw new Error(`Watch cancel failed (${res.status})`);
        // Empty when the watch had already resolved: then nothing was written.
        const data = (await res.json()) as { messages?: UIMessage[] };
        if (data.messages?.length) {
          const messages = data.messages;
          setAppendedMessages((current) => ({
            chatId,
            messages,
            seq: (current?.seq ?? 0) + 1,
          }));
        }
      } catch (error) {
        console.error("Dashboard agent: failed to cancel watch", error);
        toast.error("We couldn't stop that watch. Try again in a moment.");
      }
      void loadHistory();
    },
    [actionPath, active?.chatId, loadHistory, toast]
  );

  // Titles are written when the first turn settles, so a new chat has none yet.
  const activeChat = active ? chats.find((chat) => chat.id === active.chatId) : undefined;
  const headerTitle = active ? (activeChat?.title ?? "Chat") : "New chat";

  // Not filtered to active: the wake banner needs watches that already fired.
  const chatWatches = activeChat?.watches ?? [];

  /* oxlint-disable jsx-a11y/no-static-element-interactions -- Escape handling intentionally bubbles from focused controls inside the panel. */
  return (
    <div
      ref={panelRef}
      className="flex h-full flex-col bg-background-bright animate-in slide-in-from-right-2 duration-150"
      // A React handler, not a global hotkey, so Esc stays scoped to the panel.
      onKeyDown={(event) => {
        if (
          !escapeClosesPanel({
            key: event.key,
            defaultPrevented: event.defaultPrevented,
            targetInsidePanel: panelRef.current?.contains(event.target as Node) ?? false,
          })
        )
          return;
        event.preventDefault();
        onClose();
      }}
    >
      <DashboardAgentHeader
        title={headerTitle}
        chats={chats}
        currentChatId={active?.chatId ?? ""}
        thinkingChatId={thinkingChatId}
        onNewChat={newChat}
        showNewChat={active !== null}
        onOpenHistory={loadHistory}
        onSelectChat={switchChat}
        onDeleteChat={deleteChat}
        onToggleFullscreen={onToggleFullscreen ?? (() => {})}
        isFullscreen={isFullscreen}
        onClose={onClose}
      />

      {/* Always mounted, so the chat keeps its transport, session and transcript. */}
      <AgentPanelColumn fullscreen={isFullscreen}>
        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <AgentSpinner size={20} />
          </div>
        ) : active ? (
          <DashboardAgentChat
            key={active.chatId}
            chatId={active.chatId}
            initialMessages={active.messages}
            session={active.session}
            pendingFirstMessage={active.pendingFirstMessage}
            streaming={active.streaming}
            sendRequest={
              sendRequest && sendRequest.chatId === active.chatId ? sendRequest : undefined
            }
            clientData={clientData}
            apiOrigin={apiOrigin}
            actionPath={actionPath}
            projectSlug={project.slug}
            environmentSlug={environment.slug}
            currentPage={currentPage}
            promotedPrompt={promotedPrompt}
            watches={chatWatches}
            pagePaths={pagePaths}
            watchCard={watchCardElement}
            appendedMessages={
              appendedMessages?.chatId === active.chatId ? appendedMessages : undefined
            }
            onWatchIntent={openWatchCard}
            onCancelWatch={cancelWatch}
            // The generated chat name is written before the turn-complete chunk lands.
            onTurnSettled={loadHistory}
            onActivityChange={handleActivityChange}
            onQuotaChange={handleQuotaChange}
          />
        ) : (
          <DashboardAgentDraft
            onSubmit={createChat}
            projectSlug={project.slug}
            environmentSlug={environment.slug}
            currentPage={currentPage}
            pageContext={pageContext}
            promotedPrompt={promotedPrompt}
            watchCard={watchCardElement}
            capReached={capReached}
          />
        )}
      </AgentPanelColumn>
    </div>
  );
}
/* oxlint-enable jsx-a11y/no-static-element-interactions */
