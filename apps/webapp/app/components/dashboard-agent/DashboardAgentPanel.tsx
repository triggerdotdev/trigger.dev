import type { UIMessage } from "@ai-sdk/react";
import { useLocation } from "@remix-run/react";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { DashboardAgentDraft } from "./DashboardAgentDraft";
import { WatchCard } from "./WatchCard";
import { watchDraftFor } from "./watch-card";
import type { TurnActivity } from "./DashboardAgentMessages";
import { DashboardAgentHeader } from "./DashboardAgentHeader";
import type { DashboardAgentChat as DashboardAgentChatListItem } from "./DashboardAgentHistory";
import type { SuggestedPrompt, WatchDraft, WatchSpec } from "@internal/dashboard-agent-contracts";
import type { AgentPageContext } from "./page-context-types";
import { agentPageLabel } from "./page-label";
import { AgentPanelColumn } from "./panel-layout";
import { concurrencyPath } from "~/utils/pathBuilder";

const lastChatStorageKey = (organizationId: string) =>
  `tdev:dashboard-agent:last-chat:${organizationId}`;

function readLastChat(storageKey: string): { chatId: string; path: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    // Pre-path entries were the bare chat id: no page to match, so start fresh.
    if (!raw.startsWith("{")) return null;
    const parsed = JSON.parse(raw) as { chatId?: string; path?: string };
    return parsed.chatId && parsed.path ? { chatId: parsed.chatId, path: parsed.path } : null;
  } catch {
    return null;
  }
}

function serializePageContext(pageContext: AgentPageContext): string | undefined {
  try {
    return JSON.stringify(pageContext);
  } catch {
    return undefined;
  }
}

type ActiveChat = {
  chatId: string;
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
  onChatRead?: (chatId: string) => void;
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

  const [chats, setChats] = useState<DashboardAgentChatListItem[]>([]);
  const [active, setActive] = useState<ActiveChat | null>(null);
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
  const handleActivityChange = useCallback((chatId: string, activity: TurnActivity | null) => {
    setThinkingChatId((previous) =>
      activity !== null ? chatId : previous === chatId ? null : previous
    );
  }, []);

  const historyInFlight = useRef<Promise<void> | null>(null);

  // The read POST and its reload can land out of order, so mask the next list.
  const justRead = useRef<Set<string>>(new Set());

  const loadHistory = useCallback(async () => {
    if (historyInFlight.current) return historyInFlight.current;
    const request = (async () => {
      try {
        const res = await fetch(actionPath);
        if (!res.ok) throw new Error(`History request failed (${res.status})`);
        const data = (await res.json()) as { chats?: DashboardAgentChatListItem[] };
        const read = justRead.current;
        justRead.current = new Set();
        setChats(
          (data.chats ?? []).map((chat) =>
            read.has(chat.id) ? { ...chat, hasUnreadWake: false } : chat
          )
        );
      } catch (error) {
        console.error("Dashboard agent: failed to load chat history", error);
        toast.error("We couldn't load your previous chats. Try again in a moment.");
      } finally {
        historyInFlight.current = null;
      }
    })();
    historyInFlight.current = request;
    return request;
  }, [actionPath, toast]);

  // Bumped on each open so a slower earlier open can't overwrite a newer one.
  const openChatRequestSeq = useRef(0);

  const openChat = useCallback(
    async (id: string) => {
      const seq = ++openChatRequestSeq.current;
      setLoading(true);
      try {
        const res = await fetch(`${actionPath}?chatId=${encodeURIComponent(id)}`);
        if (!res.ok && res.status !== 404) {
          console.error(`Dashboard agent: failed to open chat ${id} (${res.status})`);
          toast.error("We couldn't open that chat. Try again in a moment.");
        }
        const data = res.ok
          ? ((await res.json()) as {
              messages?: UIMessage[];
              session?: { publicAccessToken: string; lastEventId: string | null } | null;
            })
          : { messages: [], session: null };
        if (seq !== openChatRequestSeq.current) return;
        if (data.messages && data.messages.length > 0) {
          setActive({
            chatId: id,
            messages: data.messages,
            session: data.session?.publicAccessToken
              ? {
                  publicAccessToken: data.session.publicAccessToken,
                  lastEventId: data.session.lastEventId ?? undefined,
                }
              : null,
          });
        } else {
          setActive(null);
        }
      } catch (error) {
        console.error(`Dashboard agent: failed to open chat ${id}`, error);
        toast.error("We couldn't open that chat. Try again in a moment.");
        if (seq === openChatRequestSeq.current) setActive(null);
      } finally {
        if (seq === openChatRequestSeq.current) setLoading(false);
      }
    },
    [actionPath, toast]
  );

  const createChat = useCallback(
    async (text: string) => {
      const seq = ++openChatRequestSeq.current;
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
        };
        if (seq !== openChatRequestSeq.current) return;
        if (!res.ok || !data.chatId || !data.publicAccessToken) {
          console.error(`Dashboard agent: failed to create chat (${res.status})`, data.error);
          toast.error(data.error ?? "We couldn't start that chat. Try again in a moment.");
          setActive(null);
          return;
        }
        setActive({
          chatId: data.chatId,
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
    [actionPath, clientData, toast]
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
    openChatRequestSeq.current += 1;
    setActive(null);
    setLoading(false);
    setWatchDraft(null);
    setChats([]);
    void loadHistory();
  }, [organization.id, loadHistory]);

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
    if (!active?.chatId) return;
    try {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({ chatId: active.chatId, path: location.pathname })
      );
    } catch {
      /* ignore */
    }
  }, [active?.chatId, storageKey, location.pathname]);

  useEffect(() => {
    if (!active?.chatId) return;
    const chatId = active.chatId;
    onChatRead?.(chatId);
    justRead.current.add(chatId);
    setChats((previous) =>
      previous.map((chat) => (chat.id === chatId ? { ...chat, hasUnreadWake: false } : chat))
    );
    // Read again on the way out: a wake can land while the chat is open.
    return () => {
      onChatRead?.(chatId);
      justRead.current.add(chatId);
    };
  }, [active?.chatId, onChatRead]);

  // Bound to its chat, which remounts with a fresh guard ref on every switch.
  const [prefill, setPrefill] = useState<{ text: string; seq: number; chatId: string } | undefined>(
    undefined
  );
  const handledRequestSeq = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!requestedMessage || loading) return;
    if (handledRequestSeq.current === requestedMessage.seq) return;
    handledRequestSeq.current = requestedMessage.seq;
    if (active) {
      setPrefill({ ...requestedMessage, chatId: active.chatId });
    } else {
      void createChat(requestedMessage.text);
    }
  }, [requestedMessage, loading, active, createChat]);

  const [watchDraft, setWatchDraft] = useState<WatchDraft | null>(null);
  const [watchPending, setWatchPending] = useState(false);
  const [watchError, setWatchError] = useState<string | null>(null);
  // Carries its chat id so a later-mounted chat cannot adopt another chat's block.
  const [appendedMessage, setAppendedMessage] = useState<
    { chatId: string; message: UIMessage; seq: number } | undefined
  >(undefined);

  const handledWatchSeq = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!watchRequest || handledWatchSeq.current === watchRequest.seq) return;
    handledWatchSeq.current = watchRequest.seq;
    setWatchError(null);
    setWatchPending(false);
    setWatchDraft(watchDraftFor(watchRequest.spec));
  }, [watchRequest]);

  // Nothing is posted or persisted until the card is submitted.
  const openWatchCard = useCallback((spec: WatchSpec) => {
    setWatchError(null);
    setWatchPending(false);
    setWatchDraft(watchDraftFor(spec));
  }, []);

  const dismissWatchCard = useCallback(() => {
    setWatchDraft(null);
    setWatchError(null);
    setWatchPending(false);
  }, []);

  const submitWatch = useCallback(async () => {
    if (!watchDraft) return;
    setWatchPending(true);
    setWatchError(null);
    try {
      const body = new FormData();
      body.set("intent", "watch-create");
      body.set("draft", JSON.stringify(watchDraft));
      // A watch is chat-bound: with no chat open the server creates one.
      if (active?.chatId) body.set("chatId", active.chatId);

      const res = await fetch(actionPath, { method: "POST", body });
      const data = (await res.json()) as {
        chatId?: string;
        message?: UIMessage;
        error?: string;
      };
      if (!res.ok || !data.chatId || !data.message) {
        setWatchError(data.error ?? "We couldn't start that watch. Try again in a moment.");
        return;
      }

      if (active?.chatId === data.chatId) {
        setAppendedMessage((current) => ({
          chatId: data.chatId!,
          message: data.message!,
          seq: (current?.seq ?? 0) + 1,
        }));
      } else {
        // No session: nothing is streaming and the block is the whole chat.
        setActive({ chatId: data.chatId, messages: [data.message], session: null });
      }
      setWatchDraft(null);
      void loadHistory();
    } catch (error) {
      console.error("Dashboard agent: failed to create watch", error);
      setWatchError("We couldn't start that watch. Try again in a moment.");
    } finally {
      setWatchPending(false);
    }
  }, [watchDraft, active?.chatId, actionPath, loadHistory]);

  const watchCard = watchDraft ? (
    <WatchCard
      draft={watchDraft}
      onChange={setWatchDraft}
      onSubmit={() => void submitWatch()}
      onCancel={dismissWatchCard}
      pending={watchPending}
      error={watchError}
    />
  ) : null;

  const newChat = useCallback(() => {
    // Invalidate any in-flight open or create so its result can't replace the draft.
    openChatRequestSeq.current += 1;
    setLoading(false);
    setActive(null);
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

  return (
    <div
      className="flex h-full flex-col bg-background-bright animate-in slide-in-from-right-2 duration-150"
      // A React handler, not a global hotkey, so Esc stays scoped to the panel.
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
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
            prefill={prefill && prefill.chatId === active.chatId ? prefill : undefined}
            clientData={clientData}
            apiOrigin={apiOrigin}
            actionPath={actionPath}
            projectSlug={project.slug}
            environmentSlug={environment.slug}
            currentPage={currentPage}
            promotedPrompt={promotedPrompt}
            watches={chatWatches}
            pagePaths={pagePaths}
            watchCard={watchCard}
            appendedMessage={
              appendedMessage?.chatId === active.chatId ? appendedMessage : undefined
            }
            onWatchIntent={openWatchCard}
            onCancelWatch={cancelWatch}
            // The generated chat name is written before the turn-complete chunk lands.
            onTurnSettled={loadHistory}
            onActivityChange={handleActivityChange}
          />
        ) : (
          <DashboardAgentDraft
            onSubmit={createChat}
            projectSlug={project.slug}
            environmentSlug={environment.slug}
            currentPage={currentPage}
            pageContext={pageContext}
            promotedPrompt={promotedPrompt}
            watchCard={watchCard}
          />
        )}
      </AgentPanelColumn>
    </div>
  );
}
