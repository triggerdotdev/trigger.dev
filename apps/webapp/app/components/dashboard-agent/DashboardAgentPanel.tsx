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

// Restore the last open chat across panel re-opens and page reloads — but only
// on the page it was last used on. A closed panel reopened on a DIFFERENT page
// starts a fresh draft with that page's suggested prompts instead of dragging
// the previous conversation along. Scoped by org because chats are org-scoped.
// localStorage (not a cookie) since the panel only mounts client-side.
const lastChatStorageKey = (organizationId: string) =>
  `tdev:dashboard-agent:last-chat:${organizationId}`;

function readLastChat(storageKey: string): { chatId: string; path: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    // Pre-path entries were the bare chat id — no page to match, start fresh.
    if (!raw.startsWith("{")) return null;
    const parsed = JSON.parse(raw) as { chatId?: string; path?: string };
    return parsed.chatId && parsed.path ? { chatId: parsed.chatId, path: parsed.path } : null;
  } catch {
    return null; // localStorage unavailable / corrupted — start fresh
  }
}

// Undefined when the context can't be serialized (it should always be
// JSON-safe — it comes from loader data — but the panel must not break if a
// page's mapper puts something exotic in `filters`).
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
  // Cold start only: the agent run has no warm step-1, so the mounted chat sends
  // this first message through the transport to trigger the turn. Undefined for
  // head-started and resumed chats — their stream is resumed, not re-sent.
  pendingFirstMessage?: string;
  // True for a head-started chat: the turn is already in flight server-side, so
  // the transport must hydrate the session as streaming to resume `session.out`.
  streaming?: boolean;
};

/**
 * The dashboard agent side panel. Owns history, the active chat, and last-chat
 * persistence. New chats start in a draft state with no id; the server
 * generates the chat id on the first send (`create`) and owns the chat record,
 * so the client never invents an id. Existing chats resolve their stored
 * transcript + session before mounting `DashboardAgentChat` (keyed by chatId).
 */
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
  // Fullscreen is owned by `DashboardAgent` (it also has to hide the page
  // behind the panel), so the panel only reflects it and asks for the toggle.
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  // Text handed to the panel from outside (`openWith`). `seq` distinguishes
  // repeat requests with the same text.
  requestedMessage?: { text: string; seq: number };
  // A specific chat to show, from outside the panel (a wake toast). `seq`
  // distinguishes repeat requests for the same chat.
  openChatRequest?: { chatId: string; seq: number };
  // Bumped by the contextual ⌘J while the panel is open — each change starts a
  // new chat.
  newChatSeq?: number;
  // The product-controlled promoted prompt chip, from the feature flag.
  promotedPrompt?: SuggestedPrompt;
  // A watch card asked for by a `Watch…` entry. `seq` distinguishes repeats.
  watchRequest?: { spec: WatchSpec; seq: number };
  // The chat in front of the user changed, so its watch wakes are seen — clears
  // the launcher's unread dot.
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
  // Starts true when there's a chat to restore ON THIS PAGE, so the first
  // render already knows a restore is coming — an `openWith` request waits for
  // it instead of racing it into a new chat.
  const [loading, setLoading] = useState(
    () => readLastChat(storageKey)?.path === location.pathname
  );

  // What the banner shows. The agent gets the full pathname in `clientData`
  // (below) — this is display text only, derived from the same page context the
  // agent receives so the two can't disagree about where the user is.
  const currentPage = agentPageLabel(pageContext, location.pathname);

  // Dashboard paths for report footer actions that live on a settings page —
  // built here because only the host knows the slugs (the card stays pure).
  const pagePaths = useMemo<Record<string, string>>(
    () => ({ raise_env_limit: concurrencyPath(organization, project, environment) }),
    [organization, project, environment]
  );

  // The page context is a fresh object every render, so key the clientData memo
  // off its serialized form — otherwise every render would look like new
  // per-turn context to the transport.
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

  // Which chat has a turn in flight, for the History list's marker. Client-side
  // only: nothing server-side records a live turn, so this is the chat the panel
  // has open (or had open when History was opened — the turn keeps running).
  const [thinkingChatId, setThinkingChatId] = useState<string | null>(null);
  const handleActivityChange = useCallback((chatId: string, activity: TurnActivity | null) => {
    setThinkingChatId((previous) =>
      activity !== null ? chatId : previous === chatId ? null : previous
    );
  }, []);

  // The list is reloaded from several places at once (open, every settled turn, a
  // watch change), so a single in-flight request is shared instead of stacking:
  // callers that arrive while one is running await that one and see its result.
  const historyInFlight = useRef<Promise<void> | null>(null);

  // Chats read since the last reload. The read POST and the reload it triggers
  // can land out of order, so the next list is masked with what we know was
  // read; the ids are then dropped, so a later wake in the same chat still shows.
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

  // Bumped on each open so a slower earlier open can't overwrite a newer one
  // when chats are switched rapidly.
  const openChatRequestSeq = useRef(0);

  // Open an existing chat: fetch its stored transcript + session so resume flows
  // in through the transport at mount. A stored id that's gone (deleted / never
  // sent) drops back to the draft state.
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
          // Nothing stored under this id — drop to a fresh draft.
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

  // Start a new chat by sending its first message. The server generates the id,
  // creates the chat record, and kicks off the first turn (head start when
  // configured, else a cold session). We then mount the real chat on the server
  // id and either resume its stream (head start) or send the message through
  // the transport (cold start).
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
        // A newer open/create (or New chat) superseded this one — drop the result.
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

  // On open, restore the last chat if there is one; otherwise stay in the draft
  // state (active = null). Runs once per mount. The history list is loaded at the
  // same time: it's one cheap request, it makes the History view instant, and
  // it's where the header gets the active chat's title from.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    void loadHistory();
    const stored = readLastChat(storageKey);
    // Same page → pick the conversation back up. Different page → fresh draft
    // with this page's prompts; the old chat stays one click away in History.
    if (stored && stored.path === location.pathname) {
      void openChat(stored.chatId);
    } else {
      // `loading` starts true only when there was something to restore here.
      setLoading(false);
    }
    // location is deliberately not a dep: this is a mount-time decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openChat, storageKey, loadHistory]);

  // Crossing into another organization does NOT remount the layout (same route,
  // new params) — so the previous org's open chat and history would linger. Chats
  // are org-scoped, so the panel resets to a fresh draft and reloads this org's
  // list; the previous conversation stays where it belongs, in its own org.
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

  // A chat asked for from outside: a wake toast is about one conversation, so it
  // opens that one. Runs after the mount-time restore, and `openChat` invalidates
  // any request already in flight, so the asked-for chat is the one that lands.
  const handledOpenChatSeq = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!openChatRequest || handledOpenChatSeq.current === openChatRequest.seq) return;
    handledOpenChatSeq.current = openChatRequest.seq;
    // Already the visible transcript — nothing to load, and reloading it would
    // drop a turn in flight.
    if (openChatRequest.chatId === active?.chatId) return;
    void openChat(openChatRequest.chatId);
    // `active` is read, not tracked: a later change must not re-run the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openChatRequest, openChat]);

  // Persist the active chat and the page it's being used on — navigating with
  // the panel open keeps the chat, so the stored path follows along.
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

  // A chat becoming the visible transcript is the user reading it — mark it read
  // so the launcher's dot clears. Fires on open and on every chat switch; a draft
  // has nothing to read.
  useEffect(() => {
    if (!active?.chatId) return;
    const chatId = active.chatId;
    onChatRead?.(chatId);
    // Clear the row's highlight now rather than waiting for the next history
    // reload, so reopening the dropdown after reading doesn't show it as unread.
    justRead.current.add(chatId);
    setChats((previous) =>
      previous.map((chat) => (chat.id === chatId ? { ...chat, hasUnreadWake: false } : chat))
    );
    // Read it again on the way out, so a wake that landed while the chat was in
    // front of the user doesn't come back as unread when the panel closes.
    return () => {
      onChatRead?.(chatId);
      justRead.current.add(chatId);
    };
  }, [active?.chatId, onChatRead]);

  // Text handed in by `openWith`. With no chat open we start one and send it
  // straight away (the launcher's caller already knows what to ask); with a chat
  // open we only drop it into the composer, so we never inject a message into
  // the middle of someone's conversation. Waits for an in-flight restore/open so
  // it can tell which of the two it is.
  // The prefill is bound to the chat it was meant for: DashboardAgentChat
  // remounts (fresh guard ref) on every chat switch, so an unbound prefill
  // would re-apply to each new chat and stomp whatever the user typed.
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

  // ---------------------------------------------------------------------
  // The watch card (§2.2). Everything here is EPHEMERAL until `submitWatch`
  // succeeds: the draft, the pending flag and the error all live in the panel,
  // and dropping the card drops all three without touching the transcript.
  // ---------------------------------------------------------------------
  const [watchDraft, setWatchDraft] = useState<WatchDraft | null>(null);
  const [watchPending, setWatchPending] = useState(false);
  const [watchError, setWatchError] = useState<string | null>(null);
  // The block the server appended, handed to the open chat so it appears now
  // rather than on the next open. `seq` makes each append distinct. Carries the
  // chat it belongs to: a chat mounted later (fresh dedupe ref) must not adopt
  // another chat's confirmation.
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

  // A card offering a watch (an investigation's recurrence action, the health
  // report's recovery offer) opens the SAME card, pre-filled — never a posted
  // request, so an offer the user walks away from leaves no trace.
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
      // No chat open: the server creates one and returns its id. A watch is
      // chat-bound, so there is nowhere else for it to live.
      if (active?.chatId) body.set("chatId", active.chatId);

      const res = await fetch(actionPath, { method: "POST", body });
      const data = (await res.json()) as {
        chatId?: string;
        message?: UIMessage;
        error?: string;
      };
      if (!res.ok || !data.chatId || !data.message) {
        // Validation, cap and network failures stay in the card and persist
        // nothing — the user fixes the draft in place.
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
        // A chat that did not exist a moment ago: mount it on what the server
        // wrote. No session — nothing is streaming, the block is the whole chat.
        setActive({ chatId: data.chatId, messages: [data.message], session: null });
      }
      // The card BECOMES the persisted block, so it goes the moment that block
      // is in the transcript (§2.2 step 3/4).
      setWatchDraft(null);
      void loadHistory();
    } catch (error) {
      console.error("Dashboard agent: failed to create watch", error);
      setWatchError("We couldn't start that watch. Try again in a moment.");
    } finally {
      setWatchPending(false);
    }
  }, [watchDraft, active?.chatId, actionPath, loadHistory]);

  // Bare, placement-agnostic: the chat insets it to match its docked composer,
  // the hero's composer slot is already inset, so a wrapper here would make the
  // card narrower than the field it sits above.
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
    // Invalidate any in-flight open/create so its result can't replace the draft.
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

  // Contextual ⌘J: each bump while the panel is open starts a new chat. A ref
  // skips the mount-time value so opening the panel never resets a restored chat.
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

  // Stop watching, from the chip's ×. The chip goes immediately (the cancel is a
  // single guarded UPDATE and hardly ever fails), and the reload right after
  // restores the truth either way.
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

  // The header names what you're looking at. Titles come from the history list
  // (the agent writes one when the first turn settles), so a brand-new chat has
  // none yet and falls back to "Chat".
  const activeChat = active ? chats.find((chat) => chat.id === active.chatId) : undefined;
  const headerTitle = active ? (activeChat?.title ?? "Chat") : "New chat";

  // The watches ride along on the history list (one query for every chat), so
  // they refresh whenever it does: on open, when a turn settles, and after a
  // watch is created or cancelled. The FULL list goes down — the chips filter
  // to active themselves (a chip is an offer to cancel), while the wake banner
  // needs the kind of a watch that has already fired.
  const chatWatches = activeChat?.watches ?? [];

  return (
    <div
      className="flex h-full flex-col bg-background-bright animate-in slide-in-from-right-2 duration-150"
      // Esc closes the panel, but only while focus is inside it — a keyed
      // React handler rather than a global hotkey, so Esc still belongs to
      // whatever the user is doing elsewhere on the page. Dialogs and popovers
      // portal out of this subtree, so their own Esc handling is untouched.
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

      {/* Always mounted, so switching to fullscreen only re-styles this column —
          the chat below it keeps its transport, session and transcript. */}
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
            // One reload is enough: the agent writes the generated chat name
            // before the turn-complete chunk settles the stream, so the list
            // already reads the real name by the time this fires.
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
