import type { UIMessage } from "@ai-sdk/react";
import { useLocation } from "@remix-run/react";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Spinner } from "~/components/primitives/Spinner";
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

// Restore the last open chat across panel re-opens and page reloads. Scoped by
// org because chats are org-scoped. localStorage (not a cookie) since the panel
// only mounts client-side — the server never needs this.
const lastChatStorageKey = (organizationId: string) =>
  `tdev:dashboard-agent:last-chat:${organizationId}`;

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
export function DashboardAgentPanel({ onClose }: { onClose: () => void }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const user = useUser();
  const apiOrigin = useApiOrigin();
  const location = useLocation();

  const [view, setView] = useState<"chat" | "history">("chat");
  const [chats, setChats] = useState<DashboardAgentChatListItem[]>([]);
  const [active, setActive] = useState<ActiveChat | null>(null);
  const [loading, setLoading] = useState(false);

  const actionPath = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/dashboard-agent`;
  const storageKey = lastChatStorageKey(organization.id);

  const currentPage = location.pathname.split("/").filter(Boolean).pop() ?? "overview";

  const clientData = useMemo<DashboardAgentClientData>(
    () => ({
      userId: user.id,
      organizationId: organization.id,
      projectId: project.id,
      environmentId: environment.id,
      currentPage: location.pathname,
    }),
    [user.id, organization.id, project.id, environment.id, location.pathname]
  );

  const loadHistory = useCallback(async () => {
    const res = await fetch(actionPath);
    if (res.ok) {
      const data = (await res.json()) as { chats?: DashboardAgentChatListItem[] };
      setChats(data.chats ?? []);
    }
  }, [actionPath]);

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
      } finally {
        if (seq === openChatRequestSeq.current) setLoading(false);
      }
    },
    [actionPath]
  );

  // Start a new chat by sending its first message. The server generates the id,
  // creates the chat record, and kicks off the first turn (head start when
  // configured, else a cold session). We then mount the real chat on the server
  // id and either resume its stream (head start) or send the message through
  // the transport (cold start).
  const createChat = useCallback(
    async (text: string) => {
      setView("chat");
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
        if (!res.ok || !data.chatId || !data.publicAccessToken) {
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
      } finally {
        setLoading(false);
      }
    },
    [actionPath, clientData]
  );

  // On open, restore the last chat if there is one; otherwise stay in the draft
  // state (active = null). Runs once per mount.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(storageKey);
    } catch {
      /* localStorage unavailable — start fresh */
    }
    if (stored) void openChat(stored);
  }, [openChat, storageKey]);

  // Persist the active chat as the one to restore next time.
  useEffect(() => {
    if (!active?.chatId) return;
    try {
      window.localStorage.setItem(storageKey, active.chatId);
    } catch {
      /* ignore */
    }
  }, [active?.chatId, storageKey]);

  const newChat = useCallback(() => {
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
      await fetch(actionPath, { method: "POST", body });
      if (id === active?.chatId) newChat();
      void loadHistory();
    },
    [actionPath, active?.chatId, newChat, loadHistory]
  );

  const toggleHistory = useCallback(() => {
    setView((v) => {
      if (v === "chat") void loadHistory();
      return v === "chat" ? "history" : "chat";
    });
  }, [loadHistory]);

  return (
    <div className="flex h-full flex-col bg-background-bright animate-in slide-in-from-right-2 duration-150">
      <DashboardAgentHeader
        view={view}
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
