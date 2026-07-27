import type { UIMessage } from "@ai-sdk/react";
import { useLocation } from "@remix-run/react";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Spinner } from "~/components/primitives/Spinner";
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
import { DashboardAgentHeader } from "./DashboardAgentHeader";
import {
  DashboardAgentHistory,
  type DashboardAgentChat as DashboardAgentChatListItem,
} from "./DashboardAgentHistory";
import type { AgentPageContext } from "./page-context-types";
import { agentPageLabel } from "./page-label";

// Restore the last open chat across panel re-opens and page reloads. Scoped by
// org because chats are org-scoped. localStorage (not a cookie) since the panel
// only mounts client-side — the server never needs this.
const lastChatStorageKey = (organizationId: string) =>
  `tdev:dashboard-agent:last-chat:${organizationId}`;

function readLastChatId(storageKey: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(storageKey);
  } catch {
    return null; // localStorage unavailable — start fresh
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
}: {
  onClose: () => void;
  // Text handed to the panel from outside (`openWith`). `seq` distinguishes
  // repeat requests with the same text.
  requestedMessage?: { text: string; seq: number };
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

  const [view, setView] = useState<"chat" | "history">("chat");
  const [chats, setChats] = useState<DashboardAgentChatListItem[]>([]);
  const [active, setActive] = useState<ActiveChat | null>(null);
  // Starts true when there's a chat to restore, so the first render already
  // knows a restore is coming — an `openWith` request waits for it instead of
  // racing it into a new chat.
  const [loading, setLoading] = useState(() => readLastChatId(storageKey) !== null);

  // What the banner shows. The agent gets the full pathname in `clientData`
  // (below) — this is display text only, derived from the same page context the
  // agent receives so the two can't disagree about where the user is.
  const currentPage = agentPageLabel(pageContext, location.pathname);

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

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(actionPath);
      if (!res.ok) throw new Error(`History request failed (${res.status})`);
      const data = (await res.json()) as { chats?: DashboardAgentChatListItem[] };
      setChats(data.chats ?? []);
    } catch (error) {
      console.error("Dashboard agent: failed to load chat history", error);
      toast.error("We couldn't load your previous chats. Try again in a moment.");
    }
  }, [actionPath, toast]);

  // Bumped on each open so a slower earlier open can't overwrite a newer one
  // when chats are switched rapidly.
  const openChatRequestSeq = useRef(0);

  // Open an existing chat: fetch its stored transcript + session so resume flows
  // in through the transport at mount. A stored id that's gone (deleted / never
  // sent) drops back to the draft state.
  const openChat = useCallback(
    async (id: string) => {
      setView("chat");
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
      setView("chat");
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
    const stored = readLastChatId(storageKey);
    if (stored) {
      void openChat(stored);
    } else {
      // `loading` starts true only when there was something to restore.
      setLoading(false);
    }
  }, [openChat, storageKey, loadHistory]);

  // Persist the active chat as the one to restore next time.
  useEffect(() => {
    if (!active?.chatId) return;
    try {
      window.localStorage.setItem(storageKey, active.chatId);
    } catch {
      /* ignore */
    }
  }, [active?.chatId, storageKey]);

  // Text handed in by `openWith`. With no chat open we start one and send it
  // straight away (the launcher's caller already knows what to ask); with a chat
  // open we only drop it into the composer, so we never inject a message into
  // the middle of someone's conversation. Waits for an in-flight restore/open so
  // it can tell which of the two it is.
  const [prefill, setPrefill] = useState<{ text: string; seq: number } | undefined>(undefined);
  const handledRequestSeq = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!requestedMessage || loading) return;
    if (handledRequestSeq.current === requestedMessage.seq) return;
    handledRequestSeq.current = requestedMessage.seq;
    setView("chat");
    if (active) {
      setPrefill(requestedMessage);
    } else {
      void createChat(requestedMessage.text);
    }
  }, [requestedMessage, loading, active, createChat]);

  const newChat = useCallback(() => {
    // Invalidate any in-flight open/create so its result can't replace the draft.
    openChatRequestSeq.current += 1;
    setLoading(false);
    setView("chat");
    setActive(null);
  }, []);

  const switchChat = useCallback(
    (id: string) => {
      void openChat(id);
    },
    [openChat]
  );

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
      if (id === active?.chatId) newChat();
      void loadHistory();
    },
    [actionPath, active?.chatId, newChat, loadHistory, toast]
  );

  const toggleHistory = useCallback(() => {
    setView((v) => {
      if (v === "chat") void loadHistory();
      return v === "chat" ? "history" : "chat";
    });
  }, [loadHistory]);

  // The header names what you're looking at. Titles come from the history list
  // (the agent writes one when the first turn settles), so a brand-new chat has
  // none yet and falls back to "Chat".
  const headerTitle =
    view === "history"
      ? "Chat history"
      : active
        ? (chats.find((chat) => chat.id === active.chatId)?.title ?? "Chat")
        : "New chat";

  return (
    <div className="flex h-full flex-col bg-background-bright animate-in slide-in-from-right-2 duration-150">
      <DashboardAgentHeader
        view={view}
        title={headerTitle}
        onNewChat={newChat}
        onToggleHistory={toggleHistory}
        onClose={onClose}
      />

      {view === "history" ? (
        <DashboardAgentHistory
          chats={chats}
          currentChatId={active?.chatId ?? ""}
          onSelect={switchChat}
          onNewChat={newChat}
          onDelete={deleteChat}
        />
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-5" />
        </div>
      ) : active ? (
        <DashboardAgentChat
          key={active.chatId}
          chatId={active.chatId}
          initialMessages={active.messages}
          session={active.session}
          pendingFirstMessage={active.pendingFirstMessage}
          streaming={active.streaming}
          prefill={prefill}
          clientData={clientData}
          apiOrigin={apiOrigin}
          actionPath={actionPath}
          projectSlug={project.slug}
          environmentSlug={environment.slug}
          currentPage={currentPage}
          onTurnSettled={loadHistory}
        />
      ) : (
        <DashboardAgentDraft
          onSubmit={createChat}
          projectSlug={project.slug}
          environmentSlug={environment.slug}
          currentPage={currentPage}
        />
      )}
    </div>
  );
}
